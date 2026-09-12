/**
 * BullMQ worker'lari — TZ 11, 17-band
 *
 * Manba: 05-SYNC-QUEUE-BULLMQ.md
 *
 * MUHIM FARQ (05-fayl §3, §4):
 *   RateLimitError  -> job KECHIKTIRILADI, attempts hisobiga kirmaydi
 *   Boshqa xatolar  -> retry (5 urinish, exponential backoff)
 *   Retryable emas  -> darhol failed (validatsiya xatosi, mapping yo'q)
 *
 * Kredit tugashi xato emas — aks holda normal yuklamada job'lar
 * bekorga "failed" bo'lib qolardi.
 */

import { Worker, UnrecoverableError, DelayedError, type Job } from "bullmq";
import { config } from "../lib/config.js";
import {
  QUEUE,
  redisConnection,
  registerWorker,
  type WebhookJob,
  type ReservationSyncJob,
  type AvailabilitySyncJob,
  type RateSyncJob,
} from "./index.js";
import { processWebhookEvent } from "../services/webhookProcessor.js";
import { RateLimitError, isRetryable, getRetryDelay } from "../services/beds24/client.js";

const connection = redisConnection as never;

/** Kredit tugaganda job'ni kechiktiradi (05-fayl §3) */
async function delayForRateLimit(job: Job, e: RateLimitError, token?: string): Promise<never> {
  const ms = e.retryAfterSeconds * 1000;
  console.warn(`[worker] ${job.queueName} kredit tugadi, ${e.retryAfterSeconds}s kechiktirildi`);
  await job.moveToDelayed(Date.now() + ms, token);
  throw new DelayedError();
}

// ============================================================
//  1. Webhook worker — WebhookEvent -> Reservation
// ============================================================

export const webhookWorker = new Worker<WebhookJob>(
  QUEUE.webhook,
  async (job) => {
    const result = await processWebhookEvent(job.data.webhookEventId);

    // Mapping yo'q / bo'sh xona yo'q — qayta urinish FOYDASIZ.
    // Admin mapping'ni to'g'irlab, qo'lda "Qayta ishlash" bosadi
    // (04-fayl §7). UnrecoverableError retry'ni to'xtatadi.
    if (result.status === "needs_manual_action") {
      throw new UnrecoverableError(result.detail);
    }

    return result;
  },
  {
    connection,
    concurrency: 3,
    // Bir bron uchun bir vaqtda bitta job — ketma-ketlik kafolati
    // (05-fayl §6). Tartib buzilsa ham processor DB'dagi joriy
    // holatga qarab ishlaydi, shuning uchun natija baribir to'g'ri.
  }
);

// ============================================================
//  2. Reservation sync — PMS -> Beds24 (FAZA 10 da to'ldiriladi)
// ============================================================

export const reservationSyncWorker = new Worker<ReservationSyncJob>(
  QUEUE.reservationSync,
  async (job, token) => {
    try {
      // FAZA 10: pushReservation chaqiriladi.
      // Hozircha job qabul qilinadi va log qilinadi — navbat
      // mexanizmi ishlaydi, mazmun keyingi fazada.
      console.log(
        `[worker] reservation-sync: ${job.data.changeType} #${job.data.reservationId} ` +
        `(FAZA 10 da Beds24'ga yuboriladi)`
      );
      return { ok: true, deferred: "FAZA 10" };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      if (!isRetryable(e)) throw new UnrecoverableError(String(e).slice(0, 200));
      throw e;
    }
  },
  { connection, concurrency: 2 }
);

// ============================================================
//  3. Availability sync — PMS -> Beds24 (FAZA 9)
// ============================================================

export const availabilitySyncWorker = new Worker<AvailabilitySyncJob>(
  QUEUE.availabilitySync,
  async (job, token) => {
    try {
      console.log(
        `[worker] availability-sync: ${job.data.roomTypeIds.join(",")} ` +
        `${job.data.from}..${job.data.to} (${job.data.reason}) — FAZA 9`
      );
      return { ok: true, deferred: "FAZA 9" };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      if (!isRetryable(e)) throw new UnrecoverableError(String(e).slice(0, 200));
      throw e;
    }
  },
  { connection, concurrency: 2 }
);

// ============================================================
//  4. Rate sync — PMS -> Beds24 (FAZA 11)
// ============================================================

export const rateSyncWorker = new Worker<RateSyncJob>(
  QUEUE.rateSync,
  async (job, token) => {
    try {
      console.log(
        `[worker] rate-sync: ${job.data.roomTypeIds.join(",")} ` +
        `${job.data.from}..${job.data.to} — FAZA 11`
      );
      return { ok: true, deferred: "FAZA 11" };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      if (!isRetryable(e)) throw new UnrecoverableError(String(e).slice(0, 200));
      throw e;
    }
  },
  { connection, concurrency: 1 }
);

// ============================================================
//  Umumiy event log
// ============================================================

const allWorkers = [
  webhookWorker,
  reservationSyncWorker,
  availabilitySyncWorker,
  rateSyncWorker,
];

for (const w of allWorkers) {
  registerWorker(w);

  w.on("failed", (job, err) => {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;
    const final = attempts >= max || err instanceof UnrecoverableError;

    console.error(
      `[worker] ${w.name} ${final ? "TUGADI" : `urinish ${attempts}/${max}`}: ` +
      `${err.message.slice(0, 160)}`
    );
  });

  if (config.isDev) {
    w.on("completed", (job) => {
      console.log(`[worker] ${w.name} #${job.id} bajarildi`);
    });
  }

  w.on("error", (err) => {
    // Redis uzilishi — BullMQ o'zi qayta ulanadi
    if (config.isDev) console.warn(`[worker] ${w.name} xatosi: ${err.message}`);
  });
}

export { allWorkers };
