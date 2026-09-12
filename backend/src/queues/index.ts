/**
 * Sync navbatlari — TZ 11-band
 *
 * Manba: 05-SYNC-QUEUE-BULLMQ.md
 *
 * TZ aynan beshtasini nomma-nom talab qiladi:
 *   beds24-reservation-sync
 *   beds24-availability-sync
 *   beds24-rate-sync
 *   beds24-webhook
 *   beds24-retry
 *
 * RETRY (TZ 11-band): "API xato bersa retry -> retry -> retry"
 *   attempts: 5, exponential backoff 5s, 10s, 20s, 40s, 80s
 *
 * MUHIM (05-fayl §3): kredit tugashi XATO EMAS. Job kechiktiriladi
 * va `attempts` hisobiga kirmaydi. Aks holda normal yuklamada
 * job'lar bekorga "failed" bo'lib qolardi.
 */

import { Queue, Worker, type JobsOptions, type ConnectionOptions } from "bullmq";
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
  /** Davriy vazifalar: to'lanmagan bronlar, polling fallback */
  maintenance: "pms-maintenance",
} as const;

// --- Job payload tiplari ------------------------------------

export type WebhookJob = {
  webhookEventId: string;
};

export type ReservationSyncJob = {
  reservationId: string;
  changeType:
    | "created" | "updated" | "room_changed" | "dates_changed"
    | "guests_changed" | "price_changed" | "cancelled"
    | "checked_in" | "checked_out" | "no_show";
  previousState?: { roomId?: string; checkIn?: string; checkOut?: string };
  triggeredBy?: string;
  requestedAt: string;
};

export type AvailabilitySyncJob = {
  roomTypeIds: string[];
  from: string;
  to: string;
  reason: string;
};

export type RateSyncJob = {
  roomTypeIds: string[];
  from: string;
  to: string;
};

// --- Umumiy job sozlamalari (TZ 11-band) --------------------

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },   // 5s 10s 20s 40s 80s
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: false,        // xatolar saqlanadi — tahlil uchun
};

// --- Navbatlar ----------------------------------------------

export const webhookQueue = new Queue<WebhookJob>(QUEUE.webhook, {
  connection,
  defaultJobOptions,
});

export const reservationSyncQueue = new Queue<ReservationSyncJob>(QUEUE.reservationSync, {
  connection,
  defaultJobOptions,
});

export const availabilitySyncQueue = new Queue<AvailabilitySyncJob>(QUEUE.availabilitySync, {
  connection,
  defaultJobOptions,
});

export const rateSyncQueue = new Queue<RateSyncJob>(QUEUE.rateSync, {
  connection,
  defaultJobOptions,
});

export const allQueues = [
  webhookQueue,
  reservationSyncQueue,
  availabilitySyncQueue,
  rateSyncQueue,
];

/**
 * Navbatni monitoring ro'yxatiga qo'shadi.
 *
 * `scheduler.ts` shu faylni import qiladi, teskarisi emas —
 * sikl bo'lmasligi uchun o'zini ro'yxatga shu funksiya bilan
 * qo'shadi.
 */
export function registerQueue(q: Queue): void {
  if (!allQueues.includes(q)) allQueues.push(q);
}

// --- Monitoring (05-fayl §8) --------------------------------

export async function getQueueCounts() {
  const out: Record<string, Record<string, number>> = {};
  for (const q of allQueues) {
    out[q.name] = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  }
  return out;
}

/** Redis ishlayaptimi — /health uchun */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    await redisConnection.ping();
    return true;
  } catch {
    return false;
  }
}

// --- Toza to'xtatish ----------------------------------------

const workers: Worker[] = [];

export function registerWorker(w: Worker): void {
  workers.push(w);
}

export async function shutdownQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(allQueues.map((q) => q.close()));
  await redisConnection.quit();
}
