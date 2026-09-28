/**
 * Valyuta kursi — O'zbekiston Markaziy banki (egasi qarori Q15,
 * 2026-09-27 da qayta tasdiqlandi).
 *
 * Tizim so'mda, faqat Beds24'dan kelgan bron dollarda (chet ellik
 * mehmonlar). Kurs uch joyda kerak:
 *   - dollar bron kelganda — bronga yoziladi va QOTADI: "tagida so'm",
 *     so'mda qabul qilingan to'lov va hisobot shu kurs bilan;
 *   - Shaxmatka va Narxlar sahifasida $ ko'rsatish (bugungi kurs);
 *   - narx Beds24'ga yuborilganda — so'm narx / bugungi kurs = $.
 *
 * MANBA: cbu.uz ochiq JSON API (kalitsiz), har 3 soatda
 * (queues/scheduler.ts). Admin kursni qo'lda qo'ysa, "Markaziy bankdan
 * olish" bosilguncha avtomatik yangilanmaydi.
 *
 * SAQLASH: `Settings` jadvalida (`FX_RATE_USD`) — ishlab turgan
 * serverda o'zgaradi, qayta ishga tushirish kerak emas. Tarmoq yiqilsa
 * oxirgi ma'lum kurs ishlatiladi.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";
import { ValidationError } from "../lib/errors.js";
import { BASE_CURRENCY, baseRate, isBaseCurrency } from "../lib/money.js";
import { getSetting, setSetting } from "./settings.js";

export type FxSource = "cbu" | "manual";

export type FxRate = {
  /** "USD" */
  currency: string;
  /** 1 birlik valyuta necha so'm */
  rate: number;
  /** Kurs sanasi "YYYY-MM-DD" (Markaziy bank e'lon qilgan kun) */
  date: string | null;
  source: FxSource;
  /** Oxirgi yozilgan vaqt (ISO) */
  updatedAt: string;
  updatedBy?: string | null;
};

export const fxSettingKey = (currency: string) => `FX_RATE_${currency.toUpperCase()}`;

/** Mantiqiy chegara: xato kiritilgan nol yoki ortiqcha raqamni to'sadi */
const MIN_RATE = 1_000;
const MAX_RATE = 100_000;

function isSaneRate(v: number): boolean {
  return Number.isFinite(v) && v >= MIN_RATE && v <= MAX_RATE;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Markaziy bank manzili — `.env` dagi `FX_CBU_URL` (test) yoki cbu.uz */
function cbuUrl(currency: string): string {
  return config.fx.cbuUrl || `https://cbu.uz/uz/arkhiv-kursov-valyut/json/${encodeURIComponent(currency)}/`;
}

// ============================================================
//  O'qish
// ============================================================

/** Saqlangan kurs (tarmoqqa chiqmaydi). Yo'q bo'lsa — null */
export async function getFxRate(currency = "USD"): Promise<FxRate | null> {
  if (isBaseCurrency(currency)) return null;
  const raw = await getSetting(fxSettingKey(currency), "");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as FxRate;
    const rate = Number(v.rate);
    return isSaneRate(rate) ? { ...v, currency: currency.toUpperCase(), rate } : null;
  } catch {
    return null;
  }
}

/**
 * Joriy kurs — bron, narx va ko'rsatish uchun.
 *
 * So'm — 1. Saqlangan kurs bo'lmasa (yangi server) bir marta Markaziy
 * bankdan olishga urinadi. Olib bo'lmasa `null`: chaqiruvchi summani
 * o'girmaydi (bron baribir yaratiladi, kurs keyin to'ldiriladi).
 */
export async function rateFor(currency: string): Promise<number | null> {
  if (isBaseCurrency(currency)) return 1;
  const saved = await getFxRate(currency);
  if (saved) return saved.rate;
  try {
    return (await refreshFxRate(currency)).rate?.rate ?? null;
  } catch {
    return null;
  }
}

// ============================================================
//  Markaziy bank
// ============================================================

/**
 * Markaziy bankdan kurs.
 *
 * Javob: `[{ "Ccy": "USD", "Rate": "11830.87", "Nominal": "1",
 * "Date": "25.09.2026" }]`. `Nominal` 1 dan katta bo'lishi mumkin —
 * kurs birlikka bo'linadi.
 */
export async function fetchCbuRate(currency: string): Promise<{ rate: number; date: string }> {
  let rows: Array<{ Ccy?: string; Rate?: string; Nominal?: string; Date?: string }>;
  try {
    const res = await fetch(cbuUrl(currency), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = (await res.json()) as typeof rows;
  } catch (e) {
    throw new ValidationError(`Markaziy bank javob bermadi: ${String(e).slice(0, 120)}`);
  }

  const row = Array.isArray(rows)
    ? rows.find((r) => String(r.Ccy ?? "").toUpperCase() === currency.toUpperCase())
    : undefined;
  if (!row) throw new ValidationError(`Markaziy bank javobida ${currency} kursi topilmadi`);

  const nominal = Number(row.Nominal ?? 1) || 1;
  const rate = Math.round((Number(String(row.Rate ?? "").replace(",", ".")) / nominal) * 100) / 100;
  if (!isSaneRate(rate)) throw new ValidationError(`Markaziy bank kursi noto'g'ri: ${row.Rate}`);

  // "25.09.2026" -> "2026-09-25"
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(row.Date ?? ""));
  return { rate, date: m ? `${m[3]}-${m[2]}-${m[1]}` : todayKey() };
}

export type FxRefreshResult = {
  currency: string;
  rate: FxRate | null;
  /** Kurs qiymati o'zgardimi */
  changed: boolean;
  /** Qo'lda qo'yilgan kurs turibdi — Markaziy bank so'ralmadi */
  skippedManual?: boolean;
};

/**
 * Markaziy bankdan yangilaydi.
 *
 * `force = false` (davriy vazifa): qo'lda qo'yilgan kurs saqlanib qoladi.
 * `force = true` ("Markaziy bankdan olish" tugmasi): almashtiriladi.
 * Xato bo'lsa tashlanadi — eski kurs saqlanib qoladi.
 */
export async function refreshFxRate(
  currency = "USD",
  opts: { force?: boolean; userId?: string } = {}
): Promise<FxRefreshResult> {
  const cur = currency.toUpperCase();
  const prev = await getFxRate(cur);
  if (prev?.source === "manual" && !opts.force) {
    return { currency: cur, rate: prev, changed: false, skippedManual: true };
  }

  const { rate, date } = await fetchCbuRate(cur);
  const next: FxRate = {
    currency: cur,
    rate,
    date,
    source: "cbu",
    updatedAt: new Date().toISOString(),
    updatedBy: opts.userId ?? null,
  };
  await setSetting(fxSettingKey(cur), JSON.stringify(next), opts.userId);
  return { currency: cur, rate: next, changed: prev?.rate !== rate || prev?.source !== "cbu" };
}

/** Admin kursni qo'lda qo'yadi — "Markaziy bankdan olish" bosilguncha shu turadi */
export async function setManualFxRate(
  currency: string,
  rate: number,
  userId?: string
): Promise<FxRefreshResult> {
  const cur = currency.toUpperCase();
  if (isBaseCurrency(cur)) throw new ValidationError(`${BASE_CURRENCY} — tizim valyutasi, kursi 1`);
  if (!isSaneRate(rate)) {
    throw new ValidationError(`Kurs ${MIN_RATE}–${MAX_RATE} so'm oralig'ida bo'lishi kerak`);
  }

  const prev = await getFxRate(cur);
  const next: FxRate = {
    currency: cur,
    rate: Math.round(rate * 100) / 100,
    date: todayKey(),
    source: "manual",
    updatedAt: new Date().toISOString(),
    updatedBy: userId ?? null,
  };
  await setSetting(fxSettingKey(cur), JSON.stringify(next), userId);
  return { currency: cur, rate: next, changed: prev?.rate !== next.rate };
}

/**
 * Hisobot uchun: bronning so'mga o'girish koeffitsienti.
 *
 * Bron kursi (bron kelgan kun) ustuvor; yozilmagan bo'lsa — saqlangan
 * joriy kurs. Saqlangan kurslar BIR MARTA o'qiladi (tarmoqqa chiqmaydi) —
 * yuzlab bronli hisobot har bron uchun so'rov yubormasin.
 */
export async function reportRateResolver(): Promise<
  (r: { currency?: string | null; exchangeRate?: Prisma.Decimal | number | string | null }) => number | null
> {
  const rows = await prisma.settings.findMany({ where: { key: { startsWith: "FX_RATE_" } } });
  const saved = new Map<string, number>();
  for (const row of rows) {
    try {
      const v = JSON.parse(row.value) as FxRate;
      const rate = Number(v.rate);
      if (isSaneRate(rate)) saved.set(row.key.slice("FX_RATE_".length).toUpperCase(), rate);
    } catch {
      // buzilgan yozuv — o'tkazib yuboriladi
    }
  }
  return (r) => baseRate(r, saved.get(String(r.currency ?? "").toUpperCase()) ?? null);
}
