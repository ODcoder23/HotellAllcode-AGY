/**
 * FAZA 8 — Real-time (WebSocket) testlari
 *
 * TZ 4-band:  "Admin sahifani refresh qilmasdan ham yangi bronni
 *              ko'rishi uchun WebSocket/real-time update ishlatilsin."
 * TZ 15-band: oltita event turi talab qilinadi.
 *
 * Mezon: sayt yoki qabulxona bron yaratsa, Shaxmatka ochiq turgan
 * boshqa brauzerda sahifani yangilamasdan paydo bo'ladi.
 *
 * Test brauzer o'rnida haqiqiy WebSocket klient sifatida ulanadi:
 * agar klient event'ni olsa, brauzer ham oladi — bir xil protokol,
 * bir xil payload.
 *
 * Ishga tushirish:  npx vitest run src/realtime.test.ts
 * Shart: server, PostgreSQL (test bazasi)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import WebSocket from "ws";
import { prisma } from "./lib/prisma.js";
import { PMS_EVENTS, CHANNEL_EVENTS } from "./realtime/events.js";
import { hashPassword } from "./services/auth.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";

/**
 * WebSocket manzili PMS dan olinadi.
 *
 * Ilgari `ws://localhost:3000/ws` qattiq yozilgan edi va
 * `PMS_URL` ni umuman e'tiborga olmasdi: backend boshqa portda
 * bo'lsa (bizda 3200) barcha realtime testlari ulana olmasdi.
 * `localhost` ham muammo — Node 18+ uni IPv6 ga hal qiladi
 * (vitest.setup.ts izohiga qarang).
 */
const WS_URL = PMS.replace(/^http/, "ws") + "/ws";

/**
 * WebSocket uchun JWT token (TZ 18-band, 09-fayl §4).
 *
 * `AUTH_REQUIRED=true` bo'lganda ulanish token talab qiladi.
 * Dev'da (`false`) bo'sh qoladi va ulanish ochiq bo'ladi —
 * ikkala rejimda ham testlar ishlashi kerak.
 */
let wsToken = "";

async function loadWsToken(): Promise<void> {
  const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
  if (health?.security?.auth !== true) return;

  const res = await fetch(`${PMS}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
  });
  const body = (await res.json()) as { token?: string };
  wsToken = body.token ?? "";
}

/** Token bilan WebSocket manzili */
const wsUrl = (): string =>
  wsToken ? `${WS_URL}?token=${encodeURIComponent(wsToken)}` : WS_URL;

/**
 * WebSocket klienti — brauzer o'rnida.
 *
 * Event'lar navbatga yig'iladi, `waitFor` kutib oladi. Polling
 * emas: `resolve` xabar kelganda darhol chaqiriladi.
 */
class TestClient {
  private ws: WebSocket;
  private received: any[] = [];
  private waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      if (raw.toString() === "pong") return;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.received.push(msg);

      // Kutayotganlarni tekshiramiz
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i]!.match(msg)) {
          this.waiters.splice(i, 1)[0]!.resolve(msg);
        }
      }
    });
  }

  static async connect(): Promise<TestClient> {
    const ws = new WebSocket(wsUrl());
    /**
     * Tinglovchi `open` dan OLDIN qo'yiladi. Foydalanuvchi keshda bo'lsa
     * server `connected` ni darhol yuboradi va u upgrade javobi bilan
     * bitta TCP paketda keladi: `ws` avval `open`, keyin shu zahoti
     * `message` chiqaradi — `await` dan keyin qo'yilgan tinglovchi uni
     * yo'qotardi (CI'da "Event kelmadi ... hech narsa").
     */
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return client;
  }

  /** Shartga mos event kutadi. Allaqachon kelgan bo'lsa darhol qaytaradi. */
  waitFor(match: (m: any) => boolean, timeoutMs = 6000): Promise<any> {
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const types = this.received.map((m) => m.type).join(", ") || "hech narsa";
        reject(new Error(`Event kelmadi (${timeoutMs}ms). Kelganlari: ${types}`));
      }, timeoutMs);

      this.waiters.push({
        match,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
    });
  }

  ofType(type: string) {
    return this.received.filter((m) => m.type === type);
  }

  clear() { this.received = []; this.waiters = []; }

  close() { this.ws.removeAllListeners(); this.ws.close(); }
}

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

/** Test bronlari 2029 yilda — seed bronlariga tegmaydi */
const FAR = new Date("2029-01-01T00:00:00Z");

async function firstRoom(): Promise<{ id: string }> {
  const rooms = (await (await fetch(`${PMS}/api/rooms`)).json()) as any[];
  return rooms[0];
}

async function createBooking(checkIn: string, checkOut: string, guestName: string, phone: string) {
  const room = await firstRoom();
  const res = await post("/api/reservations", {
    roomId: room.id, checkIn, checkOut, guestName, phone, adults: 1, pricePerNight: 100_000,
  });
  expect(res.status).toBe(201);
  return res.body;
}

let client: TestClient;

describe("FAZA 8 — real-time WebSocket (TZ 4, 15-band)", () => {
  beforeAll(async () => {
    const res = await fetch(`${PMS}/health`);
    if (!res.ok) throw new Error("Server ishlamayapti");
    const health = (await res.json()) as any;
    if (!health.realtime) throw new Error("/health'da realtime yo'q — server yangilanmagan");
    await loadWsToken();
  });

  beforeEach(async () => {
    await prisma.reservation.deleteMany({ where: { checkIn: { gte: FAR } } });
    client = await TestClient.connect();
  });

  afterEach(() => { client?.close(); });

  afterAll(async () => {
    await prisma.reservation.deleteMany({ where: { checkIn: { gte: FAR } } });
  });

  // --- Event ro'yxati: TZ 15-band ------------------------------
  describe("event turlari (TZ 15-band)", () => {
    it("TZ talab qilgan oltita event aniqlangan", () => {
      expect(PMS_EVENTS).toEqual([
        "reservation.created",
        "reservation.updated",
        "reservation.cancelled",
        "room.status.changed",
        "availability.changed",
        "payment.updated",
      ]);
    });

    it("Beds24 ogohlantirishlari alohida — STOP event'i yo'q", () => {
      expect(CHANNEL_EVENTS).toEqual(["sync.failed", "webhook.needs_attention", "rate.sync.updated"]);
      for (const e of CHANNEL_EVENTS) expect(PMS_EVENTS).not.toContain(e as never);
      expect([...PMS_EVENTS, ...CHANNEL_EVENTS] as string[]).not.toContain("system.sales_stop");
    });
  });

  // --- Ulanish -------------------------------------------------
  describe("ulanish", () => {
    it("ulanganda 'connected' xabari keladi", async () => {
      const msg = await client.waitFor((m) => m.type === "connected");
      expect(msg.serverStartedAt).toBeTruthy();
    });

    it("serverStartedAt barqaror — restart bo'lmasa o'zgarmaydi", async () => {
      const a = await client.waitFor((m) => m.type === "connected");
      const second = await TestClient.connect();
      try {
        const b = await second.waitFor((m) => m.type === "connected");
        expect(b.serverStartedAt).toBe(a.serverStartedAt);
      } finally {
        second.close();
      }
    });

    it("/health real-time statistikasini ko'rsatadi", async () => {
      const health = (await (await fetch(`${PMS}/health`)).json()) as any;
      expect(health.realtime.clients).toBeGreaterThanOrEqual(1);
      expect(typeof health.realtime.redisPubSub).toBe("boolean");
    });

    it("ping -> pong", async () => {
      const ws = new WebSocket(wsUrl());
      await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
      const pong = await new Promise<string>((resolve) => {
        ws.on("message", (raw) => {
          const s = raw.toString();
          if (s === "pong") resolve(s);
        });
        ws.send("ping");
      });
      expect(pong).toBe("pong");
      ws.close();
    });
  });

  // --- Autentifikatsiya (TZ 18-band, 09-fayl §4) --------------
  describe("ulanish autentifikatsiyasi", () => {
    /** Ulanish natijasini aniqlaydi: qabul qilindimi yoki yopildimi */
    const probe = (url: string): Promise<{ accepted: boolean; code?: number }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { ws.close(); resolve({ accepted: false }); }, 5000);

        ws.on("message", () => {
          clearTimeout(timer); ws.close();
          resolve({ accepted: true });
        });
        ws.on("close", (code) => {
          clearTimeout(timer);
          resolve({ accepted: false, code });
        });
        ws.on("error", () => {
          clearTimeout(timer);
          resolve({ accepted: false });
        });
      });

    it("to'g'ri token bilan ulanish qabul qilinadi", async () => {
      const r = await probe(wsUrl());
      expect(r.accepted, "to'g'ri token rad etildi").toBe(true);
    }, 15000);

    it("AUTH_REQUIRED=true bo'lsa tokensiz ulanish rad etiladi", async () => {
      // Dev rejimida (`false`) ulanish ochiq — test o'zini
      // o'tkazib yuboradi
      if (!wsToken) return;

      const r = await probe(WS_URL);
      expect(r.accepted, "tokensiz ulanish qabul qilindi").toBe(false);
      // 1008 = Policy Violation
      expect(r.code).toBe(1008);
    }, 15000);

    it("buzilgan token rad etiladi", async () => {
      if (!wsToken) return;

      const r = await probe(`${WS_URL}?token=buzilgan.token.qiymati`);
      expect(r.accepted).toBe(false);
      expect(r.code).toBe(1008);
    }, 15000);

    it("o'chirilgan foydalanuvchining tokeni bilan ulanib bo'lmaydi", async () => {
      if (!wsToken) return;

      // Alohida xodim hisobi: token olinadi, keyin hisob o'chiriladi
      const email = "ws-ochirilgan@imron.local";
      await prisma.user.deleteMany({ where: { email } });
      await prisma.user.create({
        data: { email, fullName: "WS Test", role: "STAFF", passwordHash: await hashPassword("parol12345") },
      });
      const login = await fetch(`${PMS}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "parol12345" }),
      }).then((r) => r.json() as any);
      expect(login.token).toBeTruthy();

      const ok = await probe(`${WS_URL}?token=${encodeURIComponent(login.token)}`);
      expect(ok.accepted).toBe(true);

      await prisma.user.update({ where: { email }, data: { isActive: false } });
      // Sessiya keshi 10 s — kutib o'tiramiz emas, yangi ulanish bazadan tekshiriladi
      await new Promise((r) => setTimeout(r, 10_500));
      const denied = await probe(`${WS_URL}?token=${encodeURIComponent(login.token)}`);
      expect(denied.accepted, "o'chirilgan hisob ulandi").toBe(false);

      await prisma.user.deleteMany({ where: { email } });
    }, 30000);
  });

  // --- ASOSIY MEZON: bron refresh'siz ko'rinadi -----------------
  describe("mezon — bron sahifani yangilamasdan keladi", () => {
    it("event payload'i Shaxmatka kutgan shaklda — konvertatsiya kerak emas", async () => {
      const created = await createBooking("2029-08-10", "2029-08-13", "Shakl Testi", "+998900000011");
      const evt = await client.waitFor(
        (m) => m.type === "reservation.created" && m.reservation.id === created.id
      );
      const r = evt.reservation;
      // serializeReservation shakli — flatten, kichik harfli kalitlar
      expect(r.guestName).toBe("Shakl Testi");
      expect(r.phone).toBe("+998900000011");
      expect(r.checkIn).toBe("2029-08-10");
      expect(r.checkOut).toBe("2029-08-13");
      expect(r.status).toBe("confirmed");
      expect(r.source).toBe("direct");
      expect(r.totalPrice).toBe(300_000);
      // Beds24 maydonlari (2026-09-27): so'm bron, PMS'da boshqariladi
      expect(r.channelOwned).toBe(false);
      expect(r.currency).toBe("UZS");
      expect(r.origin).toBe("pms");
    });

    it("event bilan birga xona holati ham keladi", async () => {
      const created = await createBooking("2029-08-20", "2029-08-21", "Xona Holati", "+998900000012");
      const evt = await client.waitFor(
        (m) => m.type === "reservation.created" && m.reservation.id === created.id
      );
      expect(evt.room).toBeTruthy();
      expect(evt.room.id).toBe(created.roomId);
    });

    it("bir necha brauzer ochiq bo'lsa — hammasi oladi", async () => {
      const second = await TestClient.connect();
      try {
        const created = await createBooking("2029-08-25", "2029-08-26", "Ikki Oyna", "+998900000013");
        const match = (m: any) => m.type === "reservation.created" && m.reservation.id === created.id;
        const [a, b] = await Promise.all([client.waitFor(match), second.waitFor(match)]);
        expect(a.reservation.id).toBe(b.reservation.id);
      } finally {
        second.close();
      }
    });

    it("xona holati qo'lda o'zgarsa room.status.changed keladi", async () => {
      // Mehmonsiz xona: band xona "iflos" belgilansa ham OCCUPIED qoladi
      const rooms = (await (await fetch(`${PMS}/api/rooms`)).json()) as any[];
      const room = rooms.find((r) => r.status === "available")!;
      const res = await fetch(`${PMS}/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dirty" }),
      });
      expect(res.status).toBe(200);
      const evt = await client.waitFor((m) => m.type === "room.status.changed" && m.room.id === room.id);
      expect(evt.room.status).toBe("dirty");

      // Qaytarish (menejer/admin huquqi — test ADMIN)
      await fetch(`${PMS}/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "available" }),
      });
    });
  });

  // --- PMS ichidagi amallar ------------------------------------
  describe("PMS amallari ham event yuboradi", () => {
    const findRoom = firstRoom;

    it("PMS'da bron yaratilsa reservation.created keladi", async () => {
      const room = await findRoom();
      const res = await post("/api/reservations", {
        roomId: room.id,
        checkIn: "2029-09-05",
        checkOut: "2029-09-07",
        guestName: "Ichki Mehmon",
        phone: "+998900000001",
        adults: 1,
        pricePerNight: 100,
      });
      expect(res.status).toBe(201);

      const evt = await client.waitFor(
        (m) => m.type === "reservation.created" && m.reservation.id === res.body.id
      );
      expect(evt.reservation.guestName).toBe("Ichki Mehmon");

      await prisma.reservation.delete({ where: { id: res.body.id } }).catch(() => {});
    });

    it("to'lov qo'shilsa payment.updated keladi (TZ 14-band)", async () => {
      const room = await findRoom();
      const created = await post("/api/reservations", {
        roomId: room.id,
        checkIn: "2029-09-20",
        checkOut: "2029-09-22",
        guestName: "Tolov Testi",
        phone: "+998900000002",
        adults: 1,
        pricePerNight: 150,
      });
      const id = created.body.id;
      client.clear();

      await post(`/api/reservations/${id}/payments`, { amount: 100, method: "cash" });

      const evt = await client.waitFor(
        (m) => m.type === "payment.updated" && m.reservation.id === id
      );
      expect(evt.reservation.paidAmount).toBe(100);

      await prisma.payment.deleteMany({ where: { reservationId: id } });
      await prisma.reservation.delete({ where: { id } }).catch(() => {});
    });

    it("bron bekor qilinsa reservation.cancelled keladi", async () => {
      const room = await findRoom();
      const created = await post("/api/reservations", {
        roomId: room.id,
        checkIn: "2029-10-01",
        checkOut: "2029-10-03",
        guestName: "Bekor Testi",
        phone: "+998900000003",
        adults: 1,
        pricePerNight: 75,
      });
      const id = created.body.id;
      client.clear();

      await post(`/api/reservations/${id}/cancel`, {});

      const evt = await client.waitFor(
        (m) => m.type === "reservation.cancelled" && m.reservation.id === id
      );
      // TZ 2-band: bron o'chirilmaydi, statusi o'zgaradi — tarix saqlanadi
      expect(evt.reservation.status).toBe("cancelled");

      await prisma.reservation.delete({ where: { id } }).catch(() => {});
    });
  });

  // --- Ishonchlilik (09-fayl §5) --------------------------------
  describe("ishonchlilik", () => {
    it("WebSocket yo'q bo'lsa ham bron yaratiladi", async () => {
      client.close();     // brauzer yopildi

      const created = await createBooking("2029-11-10", "2029-11-11", "Oynasiz", "+998900000021");
      const saved = await prisma.reservation.findUnique({ where: { id: created.id } });
      expect(saved).toBeTruthy();

      client = await TestClient.connect();   // afterEach uchun
    });

    it("klient uzilsa server yiqilmaydi va boshqalarga yuborishda davom etadi", async () => {
      const temp = await TestClient.connect();
      temp.close();
      await new Promise((r) => setTimeout(r, 300));

      const created = await createBooking("2029-11-20", "2029-11-21", "Uzilish Testi", "+998900000022");
      const evt = await client.waitFor(
        (m) => m.type === "reservation.created" && m.reservation.id === created.id
      );
      expect(evt.reservation.guestName).toBe("Uzilish Testi");
    });
  });
});
