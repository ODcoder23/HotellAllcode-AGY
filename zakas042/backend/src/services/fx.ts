/**
 * Dollar kursi — FAQAT KO'RSATISH UCHUN (egasi qarori, 2026-09-27)
 *
 * Tizimda pul faqat so'mda saqlanadi. Kurs founder'ga ko'rsatiladi:
 * Narxlar kataklari ostidagi $, Shaxmatka bron oynasidagi $,
 * Beds24 narxini (USD) PMS narxi (so'm) bilan solishtirish.
 *
 * Manba — O'zbekiston Markaziy banki (cbu.uz), har 3 soatda.
 * Founder qo'lda kurs qo'ysa, u "Markaziy bankdan olish" bosilguncha
 * saqlanadi — avtomatik yangilanish qo'lda qo'yilgan kursni bosmaydi.
 */

import { config } from "../lib/config.js";
import { getSetting, setSetting } from "./settings.js";
import { ValidationError } from "../lib/errors.js";

export const FX_SETTING_KEY = "FX_RATE_USD";

export type FxRate = {
  currency: "USD";
  /** 1 $ necha so'm */
  rate: number;
  source: "cbu" | "manual";
  /** Kurs sanasi (Markaziy bank e'lon qilgan kun), YYYY-MM-DD */
  date: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

/** Mantiqiy chegara: xato kiritilgan nol yoki ortiqcha raqamni to'sadi */
const MIN_RATE = 1_000;
const MAX_RATE = 100_000;

function valid(rate: number): boolean {
  return Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE;
}

export async function getFx(): Promise<FxRate | null> {
  const raw = await getSetting(FX_SETTING_KEY, "");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as FxRate;
    return valid(Number(v.rate)) ? { ...v, currency: "USD", rate: Number(v.rate) } : null;
  } catch {
    return null;
  }
}

export async function setManualFx(rate: number, userId?: string): Promise<FxRate> {
  if (!valid(rate)) {
    throw new ValidationError(`Kurs ${MIN_RATE}–${MAX_RATE} so'm oralig'ida bo'lishi kerak`);
  }
  const fx: FxRate = {
    currency: "USD",
    rate: Math.round(rate * 100) / 100,
    source: "manual",
    date: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    updatedBy: userId ?? null,
  };
  await setSetting(FX_SETTING_KEY, JSON.stringify(fx), userId);
  return fx;
}

type CbuRow = { Ccy?: string; Rate?: string; Nominal?: string; Date?: string };

/** Markaziy bankdan joriy kurs. Javob shakli: [{Ccy, Rate, Nominal, Date: "DD.MM.YYYY"}] */
export async function fetchCbuRate(): Promise<{ rate: number; date: string | null }> {
  let rows: CbuRow[];
  try {
    const res = await fetch(config.fx.cbuUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = (await res.json()) as CbuRow[];
  } catch (e) {
    throw new ValidationError(`Markaziy bank javob bermadi: ${String(e).slice(0, 120)}`);
  }

  const usd = Array.isArray(rows) ? rows.find((r) => r.Ccy === "USD") : undefined;
  const nominal = Number(usd?.Nominal ?? 1) || 1;
  const rate = Number(String(usd?.Rate ?? "").replace(",", ".")) / nominal;
  if (!usd || !valid(rate)) {
    throw new ValidationError("Markaziy bank javobida USD kursi topilmadi");
  }

  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(usd.Date ?? "");
  return { rate: Math.round(rate * 100) / 100, date: m ? `${m[3]}-${m[2]}-${m[1]}` : null };
}

/**
 * Markaziy bank kursini saqlaydi.
 *
 * `force = false` (davriy vazifa): qo'lda qo'yilgan kurs saqlanib
 * qoladi. `force = true` ("Markaziy bankdan olish" tugmasi): qo'lda
 * qo'yilgan kurs Markaziy bankniki bilan almashtiriladi.
 */
export async function refreshFxFromCbu(opts: { force?: boolean; userId?: string } = {}): Promise<{ fx: FxRate; changed: boolean }> {
  const current = await getFx();
  if (!opts.force && current?.source === "manual") return { fx: current, changed: false };

  const { rate, date } = await fetchCbuRate();
  const fx: FxRate = {
    currency: "USD",
    rate,
    source: "cbu",
    date,
    updatedAt: new Date().toISOString(),
    updatedBy: opts.userId ?? null,
  };
  await setSetting(FX_SETTING_KEY, JSON.stringify(fx), opts.userId);
  return { fx, changed: current?.rate !== rate || current?.source !== "cbu" };
}

/** so'm -> $ (2 xona). Kurs noma'lum bo'lsa null */
export function uzsToUsd(uzs: number, fx: FxRate | null): number | null {
  if (!fx) return null;
  return Math.round((uzs / fx.rate) * 100) / 100;
}

/** Beds24 valyutasidagi summa -> so'm */
export function toUzs(amount: number, currency: string, fx: FxRate | null): number | null {
  if (currency.toUpperCase() === "UZS") return amount;
  if (currency.toUpperCase() !== "USD" || !fx) return null;
  return Math.round(amount * fx.rate * 100) / 100;
}
