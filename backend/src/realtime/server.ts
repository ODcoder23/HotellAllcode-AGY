/**
 * WebSocket server — TZ 4, 15-band
 *
 * Manba: 09-REALTIME-WEBSOCKET.md §1, §4, §5
 *
 * TZ 4-band: "Admin sahifani refresh qilmasdan ham yangi bronni
 * ko'rishi uchun WebSocket/real-time update ishlatilsin."
 *
 * KO'P INSTANSIYA (09-fayl §1): Docker Compose bir nechta API
 * konteyneri ko'targanda, klient A 1-konteynerga, klient B
 * 2-konteynerga ulangan bo'lishi mumkin. Redis pub/sub event'ni
 * barcha instansiyalarga tarqatadi. Redis allaqachon BullMQ uchun
 * bor — qo'shimcha infratuzilma kerak emas.
 *
 * MUHIM PRINTSIP (09-fayl §5): WebSocket faqat "delta" yetkazish
 * vositasi, HAQIQAT MANBAI EMAS. Uzilish paytida o'tkazib yuborilgan
 * event'lar REST orqali qoplanadi.
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "node:http";
import IORedis from "ioredis";
import { config } from "../lib/config.js";
import { now, type RealtimeMessage } from "./events.js";

const CHANNEL = "pms:realtime";
const SERVER_STARTED_AT = now();

/** Ulangan klientlar */
const clients = new Set<WebSocket>();

let wss: WebSocketServer | null = null;
let publisher: IORedis | null = null;
let subscriber: IORedis | null = null;
/**
 * Subscribe muvaffaqiyatli bo'ldimi.
 *
 * `subscriber.status` yetarli emas: ioredis subscribe rejimiga
 * o'tganda ham "ready" qaytaradi, ya'ni SUBSCRIBE buyrug'i
 * xato bo'lsa ham "ready" ko'rinadi. Shuning uchun alohida flag.
 */
let pubSubReady = false;

// --- Yuborish ------------------------------------------------

/** Faqat SHU instansiyaning klientlariga */
function sendLocal(message: RealtimeMessage): void {
  const json = JSON.stringify(message);
  let sent = 0;

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
      sent++;
    }
  }

  if (config.isDev && sent > 0) {
    console.log(`[ws] ${message.type} -> ${sent} klient`);
  }
}

/**
 * Event yuboradi — barcha instansiyalarga.
 *
 * Redis bo'lsa pub/sub orqali (ko'p instansiya), bo'lmasa faqat
 * lokal klientlarga. Ikkinchi holatda ham ishlaydi — bitta
 * instansiyada Redis kerak emas (TZ 17-band: xatoga chidamlilik).
 */
export function broadcast(message: RealtimeMessage): void {
  if (publisher && publisher.status === "ready") {
    // Redis orqali — o'z instansiyamiz ham subscriber sifatida oladi
    publisher.publish(CHANNEL, JSON.stringify(message)).catch(() => {
      sendLocal(message);     // Redis yiqildi — zaxira yo'l
    });
    return;
  }
  sendLocal(message);
}

// --- Ishga tushirish -----------------------------------------

export function startRealtimeServer(httpServer: Server): void {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    clients.add(ws);

    // TZ 18-band: ulanish JWT bilan tasdiqlanadi (FAZA 12).
    // Hozircha ochiq — dev muhitida.
    const ip = req.socket.remoteAddress;
    if (config.isDev) console.log(`[ws] ulandi (${ip}), jami ${clients.size}`);

    // Klient uzilishdan keyin farqni bilishi uchun (09-fayl §5)
    ws.send(JSON.stringify({
      type: "connected",
      timestamp: now(),
      serverStartedAt: SERVER_STARTED_AT,
    } satisfies RealtimeMessage));

    ws.on("message", (raw: RawData) => {
      // Klient faqat ping yuboradi — boshqa xabar kutilmaydi
      if (raw.toString() === "ping") ws.send("pong");
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (config.isDev) console.log(`[ws] uzildi, qoldi ${clients.size}`);
    });

    ws.on("error", () => clients.delete(ws));
  });

  // --- Redis pub/sub (09-fayl §1) ---
  try {
    publisher = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    subscriber = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

    publisher.on("error", () => {});    // BullMQ ham shu Redis'ni ishlatadi, log takrorlanmasin
    subscriber.on("error", () => {});

    /**
     * Subscribe'ni "ready" hodisasida qilamiz, bir marta emas.
     *
     * ioredis qayta ulanganda subscription'lar avtomatik tiklanadi,
     * lekin "close" -> "ready" tsiklida flagni to'g'ri boshqarish
     * uchun har "ready"da qayta o'rnatamiz. SUBSCRIBE idempotent.
     */
    const doSubscribe = () => {
      subscriber
        ?.subscribe(CHANNEL)
        .then(() => { pubSubReady = true; })
        .catch((e) => {
          pubSubReady = false;
          console.warn(`[ws] Redis pub/sub yo'q (${e.message}) — faqat lokal klientlar`);
        });
    };

    if (subscriber.status === "ready") doSubscribe();
    subscriber.on("ready", doSubscribe);

    // Uzilganda flag tushadi — broadcast lokal yo'lga o'tadi
    // (TZ 17-band: Redis yo'qligi PMS'ni to'xtatmaydi)
    subscriber.on("end", () => { pubSubReady = false; });

    subscriber.on("message", (ch, payload) => {
      if (ch !== CHANNEL) return;
      try {
        sendLocal(JSON.parse(payload) as RealtimeMessage);
      } catch {
        // Buzilgan xabar — e'tiborsiz
      }
    });
  } catch (e) {
    console.warn(`[ws] Redis ulanmadi — faqat lokal klientlar: ${String(e).slice(0, 80)}`);
  }

  // O'lik ulanishlarni tozalash — har 30 soniyada
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) clients.delete(ws);
      else ws.ping();
    }
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  console.log(`  WebSocket: ws://localhost:${config.port}/ws`);
}

export async function stopRealtimeServer(): Promise<void> {
  pubSubReady = false;
  for (const ws of clients) ws.close();
  clients.clear();

  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  await Promise.all([
    publisher?.quit().catch(() => {}),
    subscriber?.quit().catch(() => {}),
  ]);
}

/** Monitoring — /health va admin uchun */
export function getRealtimeStats() {
  return {
    clients: clients.size,
    redisPubSub: pubSubReady,
    serverStartedAt: SERVER_STARTED_AT,
  };
}
