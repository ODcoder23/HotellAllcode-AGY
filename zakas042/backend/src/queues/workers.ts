/**
 * BullMQ worker'lari — TZ 11, 17-band
 *
 *   RateLimitError  -> job KECHIKTIRILADI, attempts hisobiga kirmaydi
 *   Vaqtinchalik    -> retry (5 urinish, exponential backoff), oxirida
 *                      o'lik xat (beds24-retry)
 *   Qayta urinish foydasiz (Beds24 rad etdi, mapping yo'q, qo'lda hal
 *   qilish kerak) -> job MUVAFFAQIYATLI tugaydi: holat bazada (REJECTED,
 *   NEEDS_MANUAL_ACTION), admin panel va Shaxmatka ko'rsatadi.
 *
 * 2026-09-27: ilgari "qayta urinish foydasiz" holatlar ham o'lik xatga
 * tushardi — bog'lanmagan tarif narxi har o'zgarishda dead-letter
 * bo'lib, kuniga yuzlab yozuv qo'shardi (integratsiya olib tashlanishi
 * sabablaridan biri).
 */

import { Worker, DelayedError, type Job } from "bullmq";
import { config } from "../lib/config.js";
import {
  QUEUE, redisConnection, registerWorker,
  type WebhookJob, type ReservationSyncJob, type AvailabilitySyncJob, type RateSyncJob,
} from "./index.js";
import { processWebhookEvent } from "../services/webhookProcessor.js";
import { pushReservation } from "../services/reservationSync.js";
import { syncRoomBlocksSafe } from "../services/channelBlocks.js";
import { syncRatesRange } from "../services/rates.js";
import { moveToDeadLetter } from "./deadLetter.js";
import { notifySyncFailed } from "../realtime/notify.js";
import { RateLimitError } from "../services/beds24/client.js";

const connection = redisConnection as never;

/** Kredit tugaganda job'ni kechiktiradi */
async function delayForRateLimit(job: Job, e: RateLimitError, token?: string): Promise<never> {
  console.warn(`[worker] ${job.queueName}: kredit tugadi, ${e.retryAfterSeconds}s kechiktirildi`);
  await job.moveToDelayed(Date.now() + e.retryAfterSeconds * 1000, token);
  throw new DelayedError();
}

// ============================================================
//  1. Webhook — WebhookEvent -> Reservation
// ============================================================

export const webhookWorker = new Worker<WebhookJob>(
  QUEUE.webhook,
  async (job, token) => {
    try {
      // `needs_manual_action` — qaytariladi (holat bazada, admin ko'radi)
      return await processWebhookEvent(job.data.webhookEventId);
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      throw e;
    }
  },
  { connection, concurrency: 3 }
);

// ============================================================
//  2. Bron — PMS -> Beds24
// ============================================================

export const reservationSyncWorker = new Worker<ReservationSyncJob>(
  QUEUE.reservationSync,
  async (job, token) => {
    const { reservationId, changeType } = job.data;
    try {
      // IDEMPOTENTLIK: payload'dagi eski nusxa emas, DB'dagi joriy holat
      const outcome = await pushReservation(reservationId);
      if (config.isDev) console.log(`[worker] bron ${changeType} #${reservationId}: ${outcome.status}`);

      if (outcome.status === "rejected") {
        // Beds24 rad etdi (joy yo'q) — qayta urinish foydasiz, xodim hal qiladi
        notifySyncFailed("push_reservation", outcome.error, reservationId, { telegram: true });
        return outcome;
      }
      if (outcome.status === "failed") throw new Error(outcome.error);
      return outcome;
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      throw e;
    }
  },
  { connection, concurrency: 2 }
);

// ============================================================
//  3. Xona yopilishlari — PMS -> Beds24 (`black` bron)
// ============================================================

/**
 * `beds24-availability-sync`: Beds24 ustuvor (Q9) — bo'sh joy sonini
 * Beds24 bronlardan o'zi hisoblaydi, PMS son YOZMAYDI. PMS'ning bo'sh
 * joyga ta'siri Beds24'ga ikki yo'l bilan yetadi: bron (navbat 2) va
 * xona yopilishi — shu navbat.
 */
export const availabilitySyncWorker = new Worker<AvailabilitySyncJob>(
  QUEUE.availabilitySync,
  async (job, token) => {
    try {
      const results = await syncRoomBlocksSafe(job.data.roomIds);
      const failed = results.filter((r) => r.failed > 0);
      if (failed.length > 0) {
        throw new Error(`Xona yopilishi Beds24'ga yetmadi: ${failed.map((r) => r.roomId).join(", ")}`);
      }
      return { rooms: results.length };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      throw e;
    }
  },
  { connection, concurrency: 1 }
);

// ============================================================
//  4. Narx — PMS -> Beds24
// ============================================================

export const rateSyncWorker = new Worker<RateSyncJob>(
  QUEUE.rateSync,
  async (job, token) => {
    const { roomTypeIds, from, to } = job.data;
    try {
      const result = await syncRatesRange(roomTypeIds, from, to);
      const failed = result.outcomes.filter((o) => o.status === "failed");
      if (failed.length > 0) {
        const errors = failed.map((o) => (o.status === "failed" ? `${o.roomTypeId}: ${o.error}` : "")).join("; ");
        notifySyncFailed("push_rates", errors);
        // Faqat vaqtinchalik xato qayta uriniladi (tarmoq, kurs noma'lum)
        if (failed.some((o) => o.status === "failed" && o.retryable)) throw new Error(errors);
      }
      return { sent: result.sent, skipped: result.skipped, failed: result.failed };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      throw e;
    }
  },
  { connection, concurrency: 1 }
);

// ============================================================
//  Umumiy hodisalar
// ============================================================

export const allWorkers = [webhookWorker, reservationSyncWorker, availabilitySyncWorker, rateSyncWorker];

for (const w of allWorkers) {
  registerWorker(w);

  w.on("failed", (job, err) => {
    if (err instanceof DelayedError) return;
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;
    const final = attempts >= max;
    console.error(`[worker] ${w.name} ${final ? "TUGADI" : `urinish ${attempts}/${max}`}: ${err.message.slice(0, 160)}`);
    // Barcha urinish tugagach — o'lik xat (admin panelda ko'rinadi va qayta yuboriladi)
    if (final && job) void moveToDeadLetter(job, err.message);
  });

  w.on("error", (err) => {
    // Redis uzilishi — BullMQ o'zi qayta ulanadi
    if (config.isDev) console.warn(`[worker] ${w.name} xatosi: ${err.message}`);
  });
}
