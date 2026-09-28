/**
 * Kurs yangilanishi va unga bog'liq ishlar (egasi qarori Q15).
 *
 * Davriy vazifa (har 3 soat), admin panel (qo'lda kurs / Markaziy
 * bankka qaytarish) shu yerdan chaqiradi — uch yo'l bir xil ishlasin:
 *   1. kurs yangilanadi (services/exchangeRate.ts);
 *   2. kursi yozilmagan dollar bronlar to'ldiriladi (bron kelgan payt
 *      Markaziy bank javob bermagan bo'lsa) — Shaxmatka "tagida so'm"
 *      satrini ko'rsatsin.
 *
 * Kurs o'zgarganda Beds24 narxlari QAYTA YUBORILMAYDI: Beds24 ustuvor
 * (Q9) — narx Beds24'da boshqariladi, aks holda Beds24'dagi $ narx kun
 * sayin siljirdi. Admin narxni o'zgartirganda o'sha kungi kurs bilan ketadi.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { BASE_CURRENCY, isBaseCurrency } from "../lib/money.js";
import { getFxRate, refreshFxRate, setManualFxRate, type FxRefreshResult } from "./exchangeRate.js";
import { notifyReservation } from "../realtime/notify.js";

/** Kursi yozilmagan chet valyutadagi bronlar */
const missingRateWhere = {
  exchangeRate: null,
  NOT: [{ currency: BASE_CURRENCY }, { currency: "" }],
} satisfies Prisma.ReservationWhereInput;

/** Kuzatiladigan valyutalar: USD (doim) va kursi yo'q bronlarning valyutalari */
export async function trackedCurrencies(): Promise<string[]> {
  const set = new Set<string>(["USD"]);
  const missing = await prisma.reservation.findMany({
    where: missingRateWhere,
    distinct: ["currency"],
    select: { currency: true },
  });
  for (const m of missing) if (!isBaseCurrency(m.currency)) set.add(m.currency.toUpperCase());
  return [...set];
}

/** Kursi yozilmagan dollar bronlarga joriy kurs. Qaytaradi: nechta bron */
export async function backfillReservationRates(): Promise<number> {
  const rows = await prisma.reservation.findMany({
    where: missingRateWhere,
    select: { id: true, currency: true },
  });
  let count = 0;
  for (const cur of new Set(rows.map((r) => r.currency.toUpperCase()))) {
    const fx = await getFxRate(cur);
    if (!fx) continue;
    const ids = rows.filter((r) => r.currency.toUpperCase() === cur).map((r) => r.id);
    const res = await prisma.reservation.updateMany({
      where: { id: { in: ids }, exchangeRate: null },
      data: { exchangeRate: new Prisma.Decimal(fx.rate) },
    });
    count += res.count;
    // Shaxmatka "kurs kutilmoqda" o'rniga so'm summasini ko'rsatsin
    for (const id of ids) await notifyReservation("reservation.updated", id);
  }
  return count;
}

export type FxSyncResult = {
  rates: Array<FxRefreshResult | { currency: string; error: string }>;
  backfilled: number;
};

/**
 * Markaziy bankdan yangilash. Qo'lda qo'yilgan kurs `force` bo'lmasa
 * tegilmaydi. Bitta valyuta yiqilsa boshqalari davom etadi.
 */
export async function syncFx(opts: { force?: boolean; userId?: string } = {}): Promise<FxSyncResult> {
  const rates: FxSyncResult["rates"] = [];
  for (const cur of await trackedCurrencies()) {
    try {
      rates.push(await refreshFxRate(cur, opts));
    } catch (e) {
      rates.push({ currency: cur, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  }
  return { rates, backfilled: await backfillReservationRates() };
}

/** Admin kursni qo'lda qo'yadi */
export async function applyManualFx(currency: string, rate: number, userId?: string): Promise<FxSyncResult> {
  const r = await setManualFxRate(currency, rate, userId);
  return { rates: [r], backfilled: await backfillReservationRates() };
}
