/**
 * Davriy vazifalar — TZ 3, 10, 17-band
 *
 * Manba: 13-WEBSITE-INTEGRATSIYA.md §5 (to'lanmagan bron),
 *        04-WEBHOOK-HANDLER.md §8 (polling fallback)
 *
 * NEGA BullMQ REPEATABLE, `setInterval` EMAS:
 *   - Bir nechta instansiya ko'tarilganda `setInterval` har birida
 *     ishlaydi va vazifa N marta bajariladi
 *   - BullMQ repeatable job bitta instansiyada bajariladi
 *   - Server qayta ishga tushganda jadval Redis'da saqlanib qoladi
 *
 * REDIS YO'Q BO'LSA: jadval o'rnatilmaydi, lekin PMS ishlashda
 * davom etadi (TZ 17, 19-band). Vazifalarni qo'lda ham chaqirish
 * mumkin — admin endpoint'lari orqali.
 */

import { Queue, Worker, type Job } from "bullmq";
import { config } from "../lib/config.js";
import { QUEUE, redisConnection, registerWorker, registerQueue } from "./index.js";
import { expireUnpaidBookings } from "../services/publicBooking.js";

const connection = redisConnection as never;

/** Vazifa turlari */
export type MaintenanceJob =
  | { task: "expire_unpaid" }
  | { task: "poll_beds24" };

export const maintenanceQueue = new Queue<MaintenanceJob>(QUEUE.maintenance, {
  connection,
  defaultJobOptions: {
    // Davriy vazifa — bir marta yiqilsa keyingi safar qayta uriniladi.
    // Ko'p retry navbatni to'ldiradi va foyda bermaydi.
    attempts: 2,
    backoff: { type: "fixed", delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 100 },
    removeOnFail: { age: 604_800, count: 100 },
  },
});

// ============================================================
//  Worker
// ============================================================

export const maintenanceWorker = new Worker<MaintenanceJob>(
  QUEUE.maintenance,
  async (job: Job<MaintenanceJob>) => {
    switch (job.data.task) {
      case "expire_unpaid": {
        // 13-fayl §5: to'lanmagan bron abadiy band qilib tursa
        // real sotuv yo'qoladi
        const result = await expireUnpaidBookings();
        if (result.cancelled > 0) {
          console.log(
            `[maintenance] ${result.cancelled} to'lanmagan bron bekor qilindi: ` +
            result.codes.join(", ")
          );
        }
        return result;
      }

      case "poll_beds24": {
        // FAZA 14 da to'ldiriladi (04-fayl §8 polling fallback)
        return { ok: true, deferred: "FAZA 14" };
      }

      default:
        return { ok: true, skipped: true };
    }
  },
  { connection, concurrency: 1 }
);

registerWorker(maintenanceWorker);
registerQueue(maintenanceQueue);

// ============================================================
//  Jadval
// ============================================================

/**
 * Davriy vazifalarni ro'yxatdan o'tkazadi.
 *
 * `jobId` barqaror — server qayta ishga tushganda jadval
 * takrorlanmaydi, BullMQ mavjudini qayta ishlatadi.
 */
export async function scheduleMaintenance(): Promise<void> {
  try {
    // To'lanmagan bronlar — har soatda (13-fayl §5).
    //
    // BullMQ v6 da `add({ repeat })` o'rniga `upsertJobScheduler`
    // ishlatiladi: scheduler alohida obyekt bo'lib, bir xil kalit
    // bilan qayta chaqirilsa jadval TAKRORLANMAYDI — server qayta
    // ishga tushganda dublikat yaratilmaydi.
    await maintenanceQueue.upsertJobScheduler(
      "cron_expire_unpaid",
      { pattern: "0 * * * *" },              // har soat boshida
      { name: "expire_unpaid", data: { task: "expire_unpaid" } }
    );

    if (config.isDev) {
      console.log("  Davriy vazifalar: to'lanmagan bronlarni tozalash (har soat)");
    }
  } catch (e) {
    // Redis yo'q — PMS baribir ishlaydi (TZ 17, 19-band)
    console.warn(`[maintenance] jadval o'rnatilmadi: ${String(e).slice(0, 100)}`);
  }
}

/** Qo'lda ishga tushirish — admin endpoint'i uchun */
export async function runExpireNow() {
  return expireUnpaidBookings();
}
