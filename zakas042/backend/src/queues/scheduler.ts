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
import { recalcAllRoomStatuses } from "../services/roomStatus.js";
import { notifyRoomStatus } from "../realtime/notify.js";
import { pollBookings, checkDrift, catchUpPending } from "../services/reconciliation.js";
import { pullRates } from "../services/rates.js";
import { syncFx } from "../services/fxSync.js";

const connection = redisConnection as never;

/** Vazifa turlari */
export type MaintenanceJob =
  | { task: "expire_unpaid" }
  | { task: "prune_audit" }
  | { task: "cleaning_check" }
  | { task: "room_status" }
  | { task: "kitchen_report"; offset: 0 | 1 }
  | { task: "poll_beds24" }
  | { task: "pull_rates" }
  | { task: "drift_check" }
  | { task: "catch_up" }
  | { task: "fx_refresh" };

/**
 * Olib tashlangan jadvallar: STOP va Beds24 kuzatuvi (2026-09-27).
 *
 * Jadval Redis'da saqlanadi — kod o'chirilsa ham u ishlayverardi va
 * worker noma'lum vazifa olardi. Ishga tushganda o'chiriladi (qayta
 * chaqirish xavfsiz).
 */
const OBSOLETE_SCHEDULERS = ["cron_sales_stop", "cron_channel_monitor", "cron_fx_refresh"];

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
        // To'lanmagan bron abadiy band qilib tursa
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
         * Tozalash tekshiruvi.
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

      case "poll_beds24": {
        // TZ 10-band: webhook ishlamasa ham o'zgarishlar tushadi. Birinchi
        // yurish to'liq (ulanishdan oldingi bronlar ham). Refresh token'ni
        // ham tirik tutadi (30 kun ishlatilmasa o'ladi). Ulanish yo'q — jim
        const r = await pollBookings();
        if (r.created > 0 || r.needsAction > 0) {
          console.log(
            `[beds24] polling${r.full ? " (to'liq)" : ""}: ${r.fetched} bron, ` +
            `${r.created} yangi, ${r.updated} yangilandi, ${r.needsAction} qo'lda hal qilish kerak`
          );
        }
        return r;
      }

      case "pull_rates": {
        // Beds24 narx o'zgarishi uchun webhook yubormaydi — kalendardan
        const r = await pullRates(365);
        if (r.changed > 0 || r.status === "failed") {
          console.log(`[beds24] narx: ${r.status}, ${r.changed} kun o'zgardi${r.detail ? ` (${r.detail})` : ""}`);
        }
        return r;
      }

      case "drift_check": {
        // TZ 20-band: PMS va Beds24 bo'sh joyi — faqat qayd (Beds24 ustuvor)
        const r = await checkDrift(30);
        if (r.driftDays > 0) console.warn(`[beds24] DRIFT: ${r.driftDays} kun farq qildi`);
        return r;
      }

      case "catch_up": {
        // TZ 17-band: "Beds24 qayta ishlaganda avtomatik yuborilsin"
        const r = await catchUpPending();
        const moved = r.webhooks + r.reservations.sent + r.blocks.created + r.blocks.cancelled;
        if (moved > 0 || r.reservations.rejected > 0) {
          console.log(
            `[beds24] catch-up: ${r.webhooks} webhook, ${r.reservations.sent} bron yuborildi ` +
            `(${r.reservations.rejected} rad etildi), yopish ${r.blocks.created}/${r.blocks.cancelled}`
          );
        }
        return r;
      }

      case "fx_refresh": {
        // Markaziy bank kursi (Q15): dollar bronning "tagida so'm" satri,
        // Beds24 narxi. Qo'lda qo'yilgan kurs bosilmaydi
        const r = await syncFx();
        const failed = r.rates.filter((x) => "error" in x);
        if (failed.length > 0 || r.backfilled > 0) {
          console.log(
            `[maintenance] kurs: ` +
            r.rates.map((x) => ("error" in x ? `${x.currency} xato (${x.error})` : `${x.currency} ${x.rate?.rate ?? "?"}`)).join(", ") +
            (r.backfilled > 0 ? `, ${r.backfilled} bronga kurs yozildi` : "")
          );
        }
        return r;
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

    // To'lanmagan sayt bronlari — har soat boshida
    await maintenanceQueue.upsertJobScheduler(
      "cron_expire_unpaid",
      { pattern: "0 * * * *", tz: HOTEL_TIMEZONE },
      { name: "expire_unpaid", data: { task: "expire_unpaid" } }
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

    // Beds24 (ulanish bo'lmasa har vazifa jim o'tadi). Polling 0 — hammasi o'chiq (testlar)
    const every = config.beds24.pollIntervalMinutes * 60_000;
    const catchUpEvery = config.beds24.catchUpIntervalMinutes * 60_000;
    const beds24Jobs: Array<[string, { every?: number; pattern?: string; offset?: number; tz?: string }, MaintenanceJob]> = [
      // Polling (webhook zaxirasi) — har 5 daqiqa (TZ 15-band)
      ["cron_poll_beds24", { every }, { task: "poll_beds24" }],
      // Catch-up — har 15 daqiqa, pollingdan 1 daqiqa keyin
      ["cron_catch_up", { every: catchUpEvery, offset: 60_000 }, { task: "catch_up" }],
      // Beds24 -> PMS narx — soatlik (~2 kredit)
      ["cron_pull_rates", { every: 60 * 60_000, offset: 5 * 60_000 }, { task: "pull_rates" }],
      // Bo'sh joy farqi — kunlik 04:00 (kam yuklama)
      ["cron_drift_check", { pattern: "0 4 * * *", tz: HOTEL_TIMEZONE }, { task: "drift_check" }],
    ];
    for (const [id, repeat, data] of beds24Jobs) {
      if (every > 0 && (repeat.every === undefined || repeat.every > 0)) {
        await maintenanceQueue.upsertJobScheduler(id, repeat, { name: data.task, data });
      } else {
        await maintenanceQueue.removeJobScheduler(id).catch(() => false);
      }
    }

    // Dollar kursi (Markaziy bank) — har 3 soatda, faqat ko'rsatish uchun
    await maintenanceQueue.upsertJobScheduler(
      "cron_fx_cbu",
      { every: 3 * 3_600_000 },
      { name: "fx_refresh", data: { task: "fx_refresh" } }
    );

    if (config.isDev) {
      console.log(
        `  Davriy vazifalar (${HOTEL_TIMEZONE}): to'lanmagan bronlar (soatlik), tozalash (10 daq), ` +
        `xona holati (soatlik), audit (haftalik), oshxona (07:30, 20:00), kurs (3 soat), ` +
        `Beds24 polling (${config.beds24.pollIntervalMinutes || "o'chiq"} daq), ` +
        `catch-up (${config.beds24.pollIntervalMinutes ? config.beds24.catchUpIntervalMinutes || "o'chiq" : "o'chiq"} daq), ` +
        `narx (soatlik), drift (04:00)`
      );
    }
  } catch (e) {
    // Redis yo'q — PMS baribir ishlaydi
    console.warn(`[maintenance] jadval o'rnatilmadi: ${String(e).slice(0, 100)}`);
  }
}

// --- Qo'lda ishga tushirish (admin endpoint'lari uchun) -----

export const runExpireNow = () => expireUnpaidBookings();
export const runPollNow = (full = false) => pollBookings({ full });
export const runDriftCheckNow = (days?: number) => checkDrift(days ?? 30);
export const runPullRatesNow = (days?: number) => pullRates(days ?? 365);
export const runCatchUpNow = () => catchUpPending();
