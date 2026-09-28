/**
 * Redis va BullMQ navbatlari — TZ 11-band
 *
 * TZ aynan beshtasini nomma-nom talab qiladi:
 *   beds24-reservation-sync   PMS broni -> Beds24
 *   beds24-availability-sync  xona yopilishlari -> Beds24 (`black` bron)
 *   beds24-rate-sync          narx -> Beds24
 *   beds24-webhook            Beds24 webhook'i -> PMS
 *   beds24-retry              o'lik xat: urinishlari tugagan job'lar
 * + `pms-maintenance` — davriy vazifalar (queues/scheduler.ts).
 *
 * RETRY (TZ 11-band): 5 urinish, exponential backoff 5s..80s.
 * Kredit tugashi XATO EMAS — job kechiktiriladi, `attempts` ga kirmaydi.
 *
 * Redis o'chsa PMS ishlashda davom etadi: bron, to'lov, Shaxmatka
 * Redis'ga bog'liq emas (TZ 17, 19-band). Navbatga qo'yilmagan ish DB'da
 * PENDING / QUEUED bo'lib qoladi — catch-up keyin yuboradi.
 */

import { Queue, type Worker, type JobsOptions, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { config } from "../lib/config.js";

// --- Redis ulanishi -----------------------------------------

/**
 * BullMQ `maxRetriesPerRequest: null` talab qiladi — aks holda
 * ulanish uzilganda job'lar yo'qoladi.
 */
export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
});

redisConnection.on("error", (e) => {
  // Ulanish yo'qolsa BullMQ o'zi qayta ulanadi — bu yerda faqat log
  if (config.isDev) console.warn(`[redis] ${e.message}`);
});

const connection: ConnectionOptions = redisConnection as unknown as ConnectionOptions;

// --- Navbat nomlari (TZ 11-band) ----------------------------

export const QUEUE = {
  reservationSync: "beds24-reservation-sync",
  availabilitySync: "beds24-availability-sync",
  rateSync: "beds24-rate-sync",
  webhook: "beds24-webhook",
  retry: "beds24-retry",
  /** Davriy vazifalar */
  maintenance: "pms-maintenance",
} as const;

// --- Job payload tiplari ------------------------------------

export type WebhookJob = { webhookEventId: string };

export type ReservationSyncJob = {
  reservationId: string;
  changeType:
    | "created" | "updated" | "room_changed" | "dates_changed"
    | "cancelled" | "checked_in" | "checked_out" | "no_show";
  previousState?: { roomId?: string; checkIn?: string; checkOut?: string };
  triggeredBy?: string;
  requestedAt: string;
};

/** Xona yopilishlari Beds24'ga (`black` bron) — qaysi xonalar */
export type AvailabilitySyncJob = { roomIds: string[]; reason: string };

export type RateSyncJob = { roomTypeIds: string[]; from: string; to: string };

// --- Umumiy job sozlamalari (TZ 11-band) --------------------

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },   // 5s 10s 20s 40s 80s
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 7 * 86_400, count: 1000 },
};

// --- Navbatlar ----------------------------------------------

export const webhookQueue = new Queue<WebhookJob>(QUEUE.webhook, { connection, defaultJobOptions });
export const reservationSyncQueue = new Queue<ReservationSyncJob>(QUEUE.reservationSync, { connection, defaultJobOptions });
export const availabilitySyncQueue = new Queue<AvailabilitySyncJob>(QUEUE.availabilitySync, { connection, defaultJobOptions });
export const rateSyncQueue = new Queue<RateSyncJob>(QUEUE.rateSync, { connection, defaultJobOptions });

const queues: Queue[] = [webhookQueue, reservationSyncQueue, availabilitySyncQueue, rateSyncQueue];
const workers: Worker[] = [];

/** Navbatni monitoring ro'yxatiga qo'shadi (scheduler.ts, deadLetter.ts) */
export function registerQueue(q: Queue): void {
  if (!queues.includes(q)) queues.push(q);
}

export function registerWorker(w: Worker): void {
  workers.push(w);
}

// --- Monitoring ---------------------------------------------

export async function getQueueCounts() {
  const out: Record<string, Record<string, number>> = {};
  for (const q of queues) {
    out[q.name] = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  }
  return out;
}

/** Eski yiqilgan va tugagan job'larni tozalaydi */
export async function cleanQueueHistory(): Promise<Record<string, { failed: number; completed: number }>> {
  const result: Record<string, { failed: number; completed: number }> = {};
  for (const q of queues) {
    const failedCleaned = await q.clean(0, 10000, "failed");
    const completedCleaned = await q.clean(0, 10000, "completed");
    result[q.name] = { failed: failedCleaned.length, completed: completedCleaned.length };
  }
  return result;
}

/**
 * Redis ishlayaptimi — /health uchun.
 *
 * `maxRetriesPerRequest: null` — `ping()` cheksiz kutadi degani. Redis
 * o'chganda `/health` umuman javob bermay qolardi, shuning uchun ping
 * 1 soniyalik TIMEOUT bilan o'raladi.
 */
export async function isRedisHealthy(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("redis ping timeout")), 1000);
    });
    await Promise.race([redisConnection.ping(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Navbatga qo'yishni TIMEOUT bilan o'raydi.
 *
 * `maxRetriesPerRequest: null` — `queue.add()` Redis javobini CHEKSIZ
 * kutadi: Redis o'chsa xato tashlanmaydi, so'rov osilib qoladi va bron
 * yaratish 15+ soniya kutardi (TZ 17, 19-band buzilishi).
 *
 * 2 soniyada javob kelmasa navbatga qo'yish TASHLAB YUBORILADI — ish
 * DB'da PENDING qoladi, catch-up keyinroq yuboradi. Bir marta javob
 * bermasa keyingi 30 soniya umuman urinilmaydi.
 */
let redisDownUntil = 0;
const DOWN_COOLDOWN_MS = 30_000;

export async function enqueueWithTimeout<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs = 2000
): Promise<T | null> {
  if (Date.now() < redisDownUntil) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: navbat javob bermadi`)), timeoutMs);
    });
    const result = await Promise.race([fn(), timeout]);
    redisDownUntil = 0;
    return result;
  } catch (e) {
    redisDownUntil = Date.now() + DOWN_COOLDOWN_MS;
    console.warn(`[queue] ${label} qo'yilmadi: ${String(e).slice(0, 120)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Toza to'xtatish ----------------------------------------

export async function shutdownQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(queues.map((q) => q.close()));
  await redisConnection.quit();
}
