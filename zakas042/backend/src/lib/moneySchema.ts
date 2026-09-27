/**
 * Pul maydonlari validatsiyasi — so'm.
 *
 * Tizim so'mda: tarif, nonushta, maosh, xarajat, to'lov. Chegaralar
 * real narxdan ancha yuqori, lekin qo'shimcha nol bilan kiritilgan
 * xatoni to'xtatadi. Ortiqcha to'lovni servis qarz bo'yicha baribir
 * rad etadi (services/reservations.ts, S1).
 *
 * Kasr ko'pi bilan 2 xona: so'mda tiyin odatda ishlatilmaydi, lekin
 * rad etilmaydi.
 */

import { z } from "zod";

export const MONEY_LIMITS = {
  /** Bir kecha narxi (bron, tarif) */
  pricePerNight: 50_000_000,
  /** Bitta to'lov / qo'shimcha xizmat */
  payment: 500_000_000,
  /** Nonushta, kishi boshiga */
  mealPrice: 10_000_000,
  /** Oylik maosh */
  salary: 1_000_000_000,
  /** Bitta xarajat yozuvi */
  expense: 1_000_000_000,
} as const;

/** Qiymat ko'pi bilan 2 xona kasr */
export function isCents(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

/** Ko'pi bilan 4 xona — kechalik narx (OTA jami / kechalar, 33.3333) */
function isNightPrice(v: number): boolean {
  return Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-4;
}

const CENTS_MSG = "Summa ko'pi bilan 2 xona kasr bo'lishi kerak (masalan 450000 yoki 45.50)";

const tooBig = (max: number) =>
  `Juda katta summa (chegara ${max.toLocaleString("ru-RU").replace(/ /g, " ")})`;

/** 0..max, 2 xonagacha */
export function moneyAmount(max: number) {
  return z.number().min(0).max(max, tooBig(max)).refine(isCents, CENTS_MSG);
}

/**
 * Kechalik narx: 0..max, 4 xonagacha. Sayt bronida narx tariflar
 * yig'indisi / kechalar (kasr) bo'ladi — tahrir formasi uni o'zgartirmay
 * qaytarganda rad etilmasin. Jami summa 2 xonaga yaxlitlanadi (lib/money.ts).
 */
export function nightPriceAmount(max: number) {
  return z.number().min(0).max(max, tooBig(max))
    .refine(isNightPrice, "Narx ko'pi bilan 4 xona bo'lishi kerak");
}

/** Musbat, 2 xonagacha */
export function positiveMoney(max: number) {
  return z.number().positive("Summa musbat bo'lishi kerak")
    .max(max, tooBig(max))
    .refine(isCents, CENTS_MSG);
}

/** Manfiy ham bo'lishi mumkin (qaytarish), noldan farqli — servis tekshiradi */
export function signedMoney(max: number) {
  return z.number().min(-max).max(max, tooBig(max))
    .refine(isCents, CENTS_MSG);
}
