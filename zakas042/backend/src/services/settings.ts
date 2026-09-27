/**
 * Sozlamalar — ishlab turgan serverda o'zgaradigan qiymatlar
 *
 * NEGA DB'DA, `.env` DA EMAS: nonushta narxi, bekor qilish qoidasi,
 * komissiya foizi ishlash paytida o'zgaradi. `.env` o'zgarishi server
 * qayta ishga tushirilishini talab qiladi, bu esa ishlab turgan
 * mehmonxonada qabul qilib bo'lmaydigan narsa.
 */

import { prisma } from "../lib/prisma.js";

export const SETTING_KEYS = {
  // --- Biznes qoidalari (2026-09-17, SAVOLLAR.md) ------------

  /** Nonushta — kishi boshiga, so'm (S10) */
  mealPrice: "MEAL_PRICE_PER_PERSON",
  /** Bepul bekor qilish oynasi, soat (S11) */
  freeCancelHours: "FREE_CANCEL_HOURS",
  /** Kech bekor qilishda necha kecha narxi olinadi (S11) */
  cancelFeeNights: "CANCEL_FEE_NIGHTS",
  /** OTA komissiyasi, foiz (S14) — qo'lda kiritilgan OTA bronlari uchun */
  otaCommissionPercent: "OTA_COMMISSION_PERCENT",
  /** Audit jurnali saqlash muddati, kun (S16) */
  auditRetentionDays: "AUDIT_RETENTION_DAYS",

  // --- Tozalash (TOZALIK-BOT.md) -----------------------------

  /** Mehmon chiqqanda avtomatik topshiriq yaratilsinmi */
  cleaningAuto: "CLEANING_AUTO",
  /** Javob bermasa necha daqiqadan keyin eslatilsin */
  cleaningRemindMinutes: "CLEANING_REMIND_MINUTES",
  /** Tozalash me'yori, daqiqa — hisobotda "kechikdi" uchun */
  cleaningTargetMinutes: "CLEANING_TARGET_MINUTES",
  /** Chiqish soati (Toshkent, 0-23) — shu soatdan keyin chiqish kuni tozalash xabari */
  checkoutHour: "CHECKOUT_HOUR",
} as const;

/**
 * Biznes sozlamalarining boshlang'ich qiymatlari.
 *
 * Bular 2026-09-17 da egasi bilan kelishilgan (SAVOLLAR.md).
 * Admin panelda o'zgartiriladi, bu yerda faqat birinchi qiymat.
 */
export const BUSINESS_DEFAULTS = {
  /**
   * Nonushta — kishi boshiga, so'm (Q15: tizim so'mda). Admin panel
   * Oshxona bo'limida o'zgartiriladi. 0 = belgilanmagan (panel
   * ogohlantiradi).
   */
  mealPrice: 25_000,
  /** 24 soat — undan keyin jarima */
  freeCancelHours: 24,
  /**
   * Bekor qilish jarimasi YO'Q (egasi qarori Q16, 2026-09-26: "jarima
   * yo'q"). Ilgari 1 kecha narxi edi. Mexanizm qoldi — kerak bo'lsa
   * `CANCEL_FEE_NIGHTS` sozlamasi (PUT /api/admin/business-settings)
   */
  cancelFeeNights: 0,
  /** Booking.com odatda 15-18% oladi (qo'lda kiritilgan OTA broni) */
  otaCommissionPercent: 15,
  /** Audit jurnali 1 yil saqlanadi */
  auditRetentionDays: 365,

  // --- Tozalash (2026-09-17 kelishuvi) -----------------------
  /** Mehmon chiqqanda topshiriq o'zi yaratiladi */
  cleaningAuto: true,
  /** 30 daqiqa javob bo'lmasa egasiga eslatma */
  cleaningRemindMinutes: 30,
  /** Tozalash 30 daqiqada bajarilishi kutiladi */
  cleaningTargetMinutes: 30,
  /** Chiqish soati 12:00 (Toshkent) — mehmonxonalarda odatiy */
  checkoutHour: 12,
} as const;

/**
 * Sozlamani o'qiydi.
 *
 * KESHLANMAYDI: admin qiymatni o'zgartirganda barcha jarayonlar
 * darhol yangi qiymatni ko'rishi kerak. Bitta indeksli so'rov
 * sezilmaydi.
 */
export async function getSetting(key: string, fallback: string): Promise<string> {
  try {
    const row = await prisma.settings.findUnique({ where: { key } });
    return row?.value ?? fallback;
  } catch {
    // DB vaqtincha javob bermasa standart qiymat — amal to'xtamasin
    return fallback;
  }
}

export async function setSetting(
  key: string,
  value: string,
  updatedBy?: string
): Promise<void> {
  await prisma.settings.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
}

// ============================================================
//  Biznes sozlamalari — sonli qiymatlar
// ============================================================

/**
 * Sozlamani son sifatida o'qiydi.
 *
 * Noto'g'ri qiymat (bo'sh, matn, manfiy) bo'lsa boshlang'ich
 * qiymat qaytariladi: sozlama buzilgani uchun bron yaratish
 * to'xtab qolmasin.
 */
async function getNumber(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Nonushta narxi — kishi boshiga (S10) */
export function getMealPrice(): Promise<number> {
  return getNumber(SETTING_KEYS.mealPrice, BUSINESS_DEFAULTS.mealPrice);
}

/** Bepul bekor qilish oynasi, soat (S11) */
export function getFreeCancelHours(): Promise<number> {
  return getNumber(SETTING_KEYS.freeCancelHours, BUSINESS_DEFAULTS.freeCancelHours);
}

/** Jarima necha kecha narxi (S11) */
export function getCancelFeeNights(): Promise<number> {
  return getNumber(SETTING_KEYS.cancelFeeNights, BUSINESS_DEFAULTS.cancelFeeNights);
}

/** OTA komissiyasi, foiz (S14) */
export function getOtaCommissionPercent(): Promise<number> {
  return getNumber(
    SETTING_KEYS.otaCommissionPercent,
    BUSINESS_DEFAULTS.otaCommissionPercent
  );
}

/** Audit jurnali saqlash muddati, kun (S16) */
export function getAuditRetentionDays(): Promise<number> {
  return getNumber(
    SETTING_KEYS.auditRetentionDays,
    BUSINESS_DEFAULTS.auditRetentionDays
  );
}

// ============================================================
//  Tozalash sozlamalari (TOZALIK-BOT.md)
// ============================================================

/** Mantiqiy sozlamani o'qiydi */
async function getBool(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getSetting(key, String(fallback));
  return raw === "true" || raw === "1";
}

/** Mehmon chiqqanda avtomatik topshiriq yaratilsinmi */
export function getCleaningAuto(): Promise<boolean> {
  return getBool(SETTING_KEYS.cleaningAuto, BUSINESS_DEFAULTS.cleaningAuto);
}

/** Javob bermasa eslatish vaqti, daqiqa */
export function getCleaningRemindMinutes(): Promise<number> {
  return getNumber(
    SETTING_KEYS.cleaningRemindMinutes,
    BUSINESS_DEFAULTS.cleaningRemindMinutes
  );
}

/** Chiqish soati (Toshkent vaqti) */
export async function getCheckoutHour(): Promise<number> {
  const h = await getNumber(SETTING_KEYS.checkoutHour, BUSINESS_DEFAULTS.checkoutHour);
  return Math.min(23, Math.floor(h));
}

/** Tozalash me'yori, daqiqa */
export function getCleaningTargetMinutes(): Promise<number> {
  return getNumber(
    SETTING_KEYS.cleaningTargetMinutes,
    BUSINESS_DEFAULTS.cleaningTargetMinutes
  );
}
