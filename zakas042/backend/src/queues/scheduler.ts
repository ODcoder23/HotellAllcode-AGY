/**
 * Davriy vazifalar — BullMQ `pms-maintenance` navbati
 *
 * NEGA BullMQ, `setInterval` EMAS:
 *   - Bir nechta instansiya ko'tarilganda `setInterval` har birida
 *     ishlaydi va vazifa N marta bajariladi
 *   - BullMQ jadvali bitta instansiyada bajariladi
 *   - Server qayta ishga tushganda jadval Redis'da saqlanib qoladi
 *
 * VAQT: cron jadvallari Toshkent vaqtida (`tz`). Server boshqa vaqt
 * zonasida bo'lsa ham (Europe/Berlin) oshxona hisoboti 07:30 da keladi.
 * 2026-09-26 gacha `tz` yo'q edi — hisobot server vaqtida (Toshkentda
 * 09:30–10:30) ketardi, nonushtadan keyin.
 *
 * REDIS YO'Q BO'LSA: jadval o'rnatilmaydi, lekin PMS ishlashda
 * davom etadi. Vazifalarni admin endpoint'lari orqali qo'lda ham
 * chaqirish mumkin.
 */

import { Queue, Worker, type Job } from "bullmq";
import { config } from "../lib/config.js";
import { HOTEL_TIMEZONE } from "../lib/hotelTime.js";
import { QUEUE, redisConnection, registerWorker, registerQueue } from "./index.js";
import { expireUnpaidBookings } from "../services/publicBooking.js";
import { pruneAuditLog } from "../services/auditLog.js";
import { sendPendingTasks, createDueCheckoutTasks } from "../services/cleaning.js";
import { remindStaleTasks } from "../bot/cleaning-bot.js";
import { sendDailyKitchenReport } from "../bot/kitchen-bot.js";
import { enforceSalesStop } from "../services/salesStop.js";
import { recalcAllRoomStatuses } from "../services/roomStatus.js";
import { notifyRoomStatus } from "../realtime/notify.js";

const connection = redisConnection as never;

/** Vazifa turlari */
export type MaintenanceJob =
  | { task: "expire_unpaid" }
  | { task: "sales_stop" }
  | { task: "prune_audit" }
  | { task: "cleaning_check" }
  | { task: "room_status" }
  | { task: "kitchen_report"; offset: 0 | 1 };

/**
 * Beds24 bilan birga olib tashlangan jadvallar (2026-09-26).
 *
 * Jadval Redis'da saqlanadi — kod o'chirilsa ham u ishlayverardi va
 * worker har 15 daqiqada noma'lum vazifa olardi. Ishga tushganda
 * o'chiriladi (qayta chaqirish xavfsiz).
 */
const OBSOLETE_SCHEDULERS = [
  "cron_poll_beds24", "cron_pull_rates", "cron_drift_check", "cron_catch_up", "cron_fx_refresh",
];

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

      case "sales_stop": {
        // STOP (tizim nazorati): ufq oldinga suriladi, bekor qilingan
        // bron bo'shatgan kun yopiladi
        const days = await enforceSalesStop();
        if (days > 0) console.log(`[maintenance] STOP: ${days} (xona x kun) yopildi`);
        return { days };
      }

      case "prune_audit": {
        // S16: jurnal `AUDIT_RETENTION_DAYS` kun saqlanadi. 2026-09-26
        // gacha bu vazifa jadvalga qo'yilmagan edi — jurnal cheksiz o'sardi
        const result = await pruneAuditLog();
        if (result.deleted > 0) {
          console.log(`[maintenance] audit: ${result.deleted} ta ${result.olderThanDays} kundan eski yozuv o'chirildi`);
        }
        return result;
      }

      case "cleaning_check": {
        /**
         * Tozalash tekshiruvi (TOZALIK-BOT.md).
         *
         *   1. Yuborilmay qolgan topshiriqlarni yuborish
         *   2. Javob bermaganlar haqida guruhga eslatma
         *   3. Chiqish kuni — "Chiqish" bosilmagan bo'lsa ham xabar
         */
        const [pending, reminded, due] = await Promise.all([
          sendPendingTasks(),
          remindStaleTasks(),
          createDueCheckoutTasks().catch((e) => {
            console.warn(`[maintenance] chiqish kuni tozalash: ${String(e).slice(0, 150)}`);
            return { created: 0 };
          }),
        ]);
        if (due.created > 0) console.log(`[maintenance] chiqish kuni: ${due.created} xonaga tozalash xabari`);

        if (pending.sent > 0 || reminded.sent > 0) {
          console.log(
            `[maintenance] tozalash: ${pending.sent} yuborildi, ` +
            `${reminded.sent} eslatma`
          );
        }
        return { pending: pending.sent, reminded: reminded.sent, due: due.created };
      }

      case "room_status": {
        // Kun almashdi: bugun keladigan mehmon xonasi RESERVED,
        // o'tib ketgan bron xonasi AVAILABLE (services/roomStatus.ts)
        const { changed } = await recalcAllRoomStatuses();
        for (const id of changed) await notifyRoomStatus(id);
        if (changed.length > 0) console.log(`[maintenance] xona holati: ${changed.length} ta xona yangilandi`);
        return { changed: changed.length };
      }

      case "kitchen_report": {
        const res = await sendDailyKitchenReport(job.data.offset);
        if (res.sent > 0) {
          console.log(`[maintenance] oshxona: ${res.sent} chatga hisobot yuborildi`);
        }
        return res;
      }

      default:
        // Eski (olib tashlangan) vazifa — jim o'tkazib yuboriladi
        return { ok: true, skipped: true };
    }
  },
  { connection, concurrency: 1 }
);

maintenanceWorker.on("failed", (job, err) => {
  console.error(`[maintenance] ${job?.data.task ?? "?"} yiqildi: ${err.message.slice(0, 200)}`);
});
maintenanceWorker.on("error", (err) => {
  // Redis uzilishi — BullMQ o'zi qayta ulanadi
  if (config.isDev) console.warn(`[maintenance] worker xatosi: ${err.message}`);
});

registerWorker(maintenanceWorker);
registerQueue(maintenanceQueue);

// ============================================================
//  Jadval
// ============================================================

/**
 * Davriy vazifalarni ro'yxatdan o'tkazadi.
 *
 * `upsertJobScheduler` — bir xil kalit bilan qayta chaqirilsa jadval
 * TAKRORLANMAYDI, server qayta ishga tushganda dublikat yaratilmaydi.
 */
export async function scheduleMaintenance(): Promise<void> {
  try {
    for (const id of OBSOLETE_SCHEDULERS) {
      await maintenanceQueue.removeJobScheduler(id).catch(() => false);
    }

    // To'lanmagan sayt bronlari — har soat boshida (13-fayl §5)
    await maintenanceQueue.upsertJobScheduler(
      "cron_expire_unpaid",
      { pattern: "0 * * * *", tz: HOTEL_TIMEZONE },
      { name: "expire_unpaid", data: { task: "expire_unpaid" } }
    );

    // STOP ufqi — har 15 daqiqada (faol bo'lmasa hech narsa qilmaydi)
    await maintenanceQueue.upsertJobScheduler(
      "cron_sales_stop",
      { every: 15 * 60_000 },
      { name: "sales_stop", data: { task: "sales_stop" } }
    );

    // Tozalash tekshiruvi — har 10 daqiqada. Yengil so'rov
    await maintenanceQueue.upsertJobScheduler(
      "cron_cleaning_check",
      { every: 10 * 60_000 },
      { name: "cleaning_check", data: { task: "cleaning_check" } }
    );

    // Xona holati — har soat 1-daqiqada (00:01 da kun almashadi;
    // server yarim tunda o'chiq bo'lsa keyingi soatda tiklanadi)
    await maintenanceQueue.upsertJobScheduler(
      "cron_room_status",
      { pattern: "1 * * * *", tz: HOTEL_TIMEZONE },
      { name: "room_status", data: { task: "room_status" } }
    );

    // Audit jurnali tozalash — haftada bir marta, yakshanba 03:30
    await maintenanceQueue.upsertJobScheduler(
      "cron_prune_audit",
      { pattern: "30 3 * * 0", tz: HOTEL_TIMEZONE },
      { name: "prune_audit", data: { task: "prune_audit" } }
    );

    // Oshxona hisoboti: ertalab 07:30 da bugungi nonushta,
    // kechqurun 20:00 da ertangi kun uchun mahsulot tayyorlash
    await maintenanceQueue.upsertJobScheduler(
      "cron_kitchen_morning",
      { pattern: "30 7 * * *", tz: HOTEL_TIMEZONE },
      { name: "kitchen_morning", data: { task: "kitchen_report", offset: 0 } }
    );
    await maintenanceQueue.upsertJobScheduler(
      "cron_kitchen_evening",
      { pattern: "0 20 * * *", tz: HOTEL_TIMEZONE },
      { name: "kitchen_evening", data: { task: "kitchen_report", offset: 1 } }
    );

    if (config.isDev) {
      console.log(
        `  Davriy vazifalar (${HOTEL_TIMEZONE}): to'lanmagan bronlar (soatlik), STOP (15 daq), ` +
        `tozalash (10 daq), xona holati (soatlik), audit (haftalik), oshxona (07:30, 20:00)`
      );
    }
  } catch (e) {
    // Redis yo'q — PMS baribir ishlaydi
    console.warn(`[maintenance] jadval o'rnatilmadi: ${String(e).slice(0, 100)}`);
  }
}

// --- Qo'lda ishga tushirish (admin endpoint'lari uchun) -----

export const runExpireNow = () => expireUnpaidBookings();
