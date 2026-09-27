/**
 * Mehmonxona vaqti — Toshkent (UTC+5, yozgi vaqt yo'q). YAGONA JOY.
 *
 * NEGA KERAK (2026-09-26 auditi): "bugun" to'rt xil hisoblanardi —
 * UTC (statistika, sayt, STOP, xona holati), Toshkent (oshxona,
 * tozalash), server vaqti (tozalash rejasi — server Europe/Berlin).
 * Toshkentda 00:00–05:00 oralig'ida dashboard kechagi kirishlarni
 * ko'rsatardi, sayt esa kechagi sanaga bron qabul qilardi.
 *
 * `@db.Date` ustunlari UTC yarim tuni sifatida o'qiladi va yoziladi
 * (`lib/serialize.ts` `fromDateKey`), shuning uchun "bugun" ham shu
 * shaklda: Toshkentdagi kalendar kuni, UTC 00:00.
 */

/** Toshkent UTC dan necha soat oldinda */
export const HOTEL_UTC_OFFSET_HOURS = 5;

/** Cron jadvallari uchun (BullMQ `tz`) */
export const HOTEL_TIMEZONE = "Asia/Tashkent";

const DAY_MS = 86_400_000;

/**
 * Mehmonxona bo'yicha hozirgi holat.
 *
 *   today       — Toshkentdagi bugungi kun (UTC 00:00, `@db.Date` bilan mos)
 *   hour        — Toshkent soati (0-23)
 *   dayStartUtc — Toshkentdagi bugun boshlanishi, haqiqiy vaqt nuqtasi
 *                 (`createdAt` kabi vaqt ustunlarini solishtirish uchun)
 */
export function hotelNow(now = new Date()): { today: Date; hour: number; dayStartUtc: Date } {
  const t = new Date(now.getTime() + HOTEL_UTC_OFFSET_HOURS * 3_600_000);
  const today = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  return {
    today,
    hour: t.getUTCHours(),
    dayStartUtc: new Date(today.getTime() - HOTEL_UTC_OFFSET_HOURS * 3_600_000),
  };
}

/** Toshkentdagi bugungi kun — `@db.Date` bilan solishtirish uchun */
export function hotelToday(now = new Date()): Date {
  return hotelNow(now).today;
}

/** Sanaga n kun qo'shadi (UTC yarim tuni saqlanadi) */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Vaqtni Toshkent bo'yicha "14:32" ko'rinishida (Telegram xabarlari uchun) */
export function hotelClock(d: Date): string {
  const t = new Date(d.getTime() + HOTEL_UTC_OFFSET_HOURS * 3_600_000);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}
