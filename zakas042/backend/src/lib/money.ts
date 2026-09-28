/**
 * Pul hisob-kitobi — YAGONA MANBA (2026-09-25).
 *
 * Egasi talabi: "hamma hisob-kitoblar mukammal bo'lishi lozim, qolib
 * ketmasligi kerak". Ilgari bron summasi olti joyda alohida
 * hisoblanardi (serialize, hisobot, statistika, komissiya, sayt, bot)
 * va ular bir-biridan farq qilardi: hisobotlarda nonushta yo'q edi,
 * qo'shimcha xizmatlar ikki marta sanalardi.
 *
 * Endi hamma shu fayldagi funksiyalarni chaqiradi.
 *
 * QOIDALAR
 *   - Valyuta (egasi qarori Q15, 2026-09-27 da qayta tasdiqlandi):
 *     tizim SO'MDA. Faqat Beds24'dan kelgan bron obyekt valyutasida
 *     (USD) — bronning barcha summalari o'z valyutasida, so'mga bron
 *     KELGAN kundagi kurs bilan o'giriladi (`toBase`, `paymentBase`).
 *     Summalar 2 xona (tiyin / sent).
 *   - Qo'shish SENTDA (butun son) — 0.1 + 0.2 kabi float xatosi
 *     "qarz 0.00000001" bo'lib to'lovni rad etmasin.
 *   - Kechalik narx 4 xona saqlanadi (OTA jami / kechalar, sayt tariflari
 *     yig'indisi / kechalar), jami esa sentga yaxlitlanadi:
 *     $100 / 3 kecha -> 33.3333 -> $100.00.
 *   - Bron summasi = xona + nonushta + qo'shimcha xizmatlar.
 *     Bekor qilingan / kelmagan bron summasi = faqat jarima.
 *   - Nonushta narxi BRONDA saqlanadi (`mealPricePerPerson`) —
 *     sozlama o'zgarganda qaysi bronlarga qo'llanishini admin tanlaydi
 *     (`services/mealPrice.ts`).
 */

import type { Prisma } from "@prisma/client";

type Num = Prisma.Decimal | number | string | null | undefined;

const DAY_MS = 86_400_000;

/** Decimal | string | number -> number (null -> 0) */
export function num(v: Num): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v.toString());
  return Number.isFinite(n) ? n : 0;
}

/** Summani sentga (butun son). Yarim sent — noldan uzoqqa. */
export function toCents(v: Num): number {
  const n = num(v);
  // 1.005 * 100 = 100.49999... — kichik tuzatish bilan to'g'ri yaxlitlanadi
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7);
}

export function fromCents(c: number): number {
  return c / 100;
}

/** Sentgacha yaxlitlash */
export function round2(v: Num): number {
  return fromCents(toCents(v));
}

/** Bir nechta summani sentda qo'shadi */
export function sumMoney(values: Iterable<Num>): number {
  let c = 0;
  for (const v of values) c += toCents(v);
  return fromCents(c);
}

/** Kechalar soni — `[)` qoidasi, kamida 1 */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS));
}

/** Bron kechalaridan nechtasi `[from, toEx)` davriga tushadi */
export function overlapNights(checkIn: Date, checkOut: Date, from: Date, toEx: Date): number {
  const start = checkIn > from ? checkIn : from;
  const end = checkOut < toEx ? checkOut : toEx;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / DAY_MS));
}

/** Xona summasi: kechalik narx x kecha, sentga yaxlitlangan */
export function roomTotalFor(pricePerNight: Num, nights: number): number {
  return round2(num(pricePerNight) * nights);
}

/** Nonushta: kishi boshiga narx x kishi x kecha */
export function mealTotalFor(mealPricePerPerson: Num, guests: number, nights: number): number {
  return round2(num(mealPricePerPerson) * guests * nights);
}

/**
 * Jami summadan kechalik narx (4 xona) — Decimal ustuniga yoziladi.
 * OTA jami narxi, sayt tarif yig'indisi shu yo'l bilan saqlanadi.
 */
export function perNight(total: Num, nights: number): string {
  const n = Math.max(1, nights);
  return (Math.round((num(total) / n) * 10_000) / 10_000).toFixed(4);
}

/**
 * Tarif kunlaridan oraliq narxi (sayt, qabulxona tekshiruvi).
 *
 * Har kecha O'Z tarifi bilan qo'shiladi (sentda). Ilgari o'rtacha
 * narx sentgacha yaxlitlanib kechaga ko'paytirilardi — jami tariflar
 * yig'indisidan bir necha sent farq qilardi.
 *
 * Tarifi belgilanmagan kecha bo'lsa — belgilanganlarning o'rtachasi
 * bilan to'ldiriladi (avvalgi xatti-harakat saqlandi). Hech biri
 * yo'q — null (narx yo'q, sotilmaydi).
 */
export function stayPriceFromRates(
  prices: ReadonlyArray<Num>,
  nights: number
): { roomTotal: number; perNight: number } | null {
  if (prices.length === 0 || nights < 1) return null;
  const known = sumMoney(prices);
  const missing = Math.max(0, nights - prices.length);
  const roomTotal = missing > 0 ? round2(known + (known / prices.length) * missing) : known;
  return { roomTotal, perNight: Number(perNight(roomTotal, nights)) };
}

// ============================================================
//  Bron summasi
// ============================================================

export type MoneyInput = {
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  pricePerNight: Num;
  withMeal: boolean;
  mealPricePerPerson?: Num;
  status: string;
  cancellationFee?: Num;
  charges?: ReadonlyArray<{ amount: Num }>;
  payments?: ReadonlyArray<{ amount: Num }>;
};

export type ReservationMoney = {
  nights: number;
  guests: number;
  roomTotal: number;
  mealPricePerPerson: number;
  mealTotal: number;
  chargesTotal: number;
  /** Bekor qilingan / kelmagan */
  isCancelled: boolean;
  cancellationFee: number;
  /** Mehmon to'lashi kerak: xona + ovqat + xizmat (bekor bo'lsa — jarima) */
  total: number;
  paid: number;
  /** Qarz (manfiy bo'lmaydi) */
  remaining: number;
  /** Ortiqcha to'langan — qaytarilishi kerak */
  refundDue: number;
};

/** Bekor qilingan statuslar (katta yoki kichik harf) */
export function isCancelledStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s === "CANCELLED" || s === "NO_SHOW";
}

/**
 * Bitta bronning to'liq pul holati.
 *
 * Shaxmatka, bron tafsiloti, to'lov chegarasi, sayt, bot va
 * hisobotlar shu funksiyadan foydalanadi — raqamlar hamma joyda bir xil.
 */
export function reservationMoney(r: MoneyInput): ReservationMoney {
  const nights = nightsBetween(r.checkIn, r.checkOut);
  const guests = r.adults + r.children;
  const roomTotal = roomTotalFor(r.pricePerNight, nights);
  const mealPricePerPerson = round2(r.mealPricePerPerson);
  const mealTotal = r.withMeal ? mealTotalFor(mealPricePerPerson, guests, nights) : 0;
  const chargesTotal = sumMoney((r.charges ?? []).map((c) => c.amount));
  const isCancelled = isCancelledStatus(r.status);
  const cancellationFee = round2(r.cancellationFee);

  const totalC = isCancelled
    ? toCents(cancellationFee)
    : toCents(roomTotal) + toCents(mealTotal) + toCents(chargesTotal);
  const paidC = toCents(sumMoney((r.payments ?? []).map((p) => p.amount)));

  return {
    nights,
    guests,
    roomTotal,
    mealPricePerPerson,
    mealTotal,
    chargesTotal,
    isCancelled,
    cancellationFee,
    total: fromCents(totalC),
    paid: fromCents(paidC),
    remaining: fromCents(Math.max(totalC - paidC, 0)),
    refundDue: fromCents(Math.max(paidC - totalC, 0)),
  };
}

/**
 * Bronning `[from, toEx)` davriga tushgan yashash daromadi (hisobotlar).
 *
 * Xona va nonushta kechalar bo'yicha taqsimlanadi: oy oxirida
 * boshlangan 3 kechalik bronning 1 kechasi keyingi oyga o'tadi.
 * Qo'shimcha xizmatlar bu yerda YO'Q — ular yaratilgan sanasi
 * bo'yicha alohida sanaladi (bir xizmat ikki davrga tushmasin).
 */
export function stayRevenueIn(
  r: Pick<MoneyInput, "checkIn" | "checkOut" | "adults" | "children" | "pricePerNight" | "withMeal" | "mealPricePerPerson">,
  from: Date,
  toEx: Date
): { nights: number; room: number; meal: number } {
  const n = overlapNights(r.checkIn, r.checkOut, from, toEx);
  if (n === 0) return { nights: 0, room: 0, meal: 0 };
  return {
    nights: n,
    room: roomTotalFor(r.pricePerNight, n),
    meal: r.withMeal ? mealTotalFor(r.mealPricePerPerson, r.adults + r.children, n) : 0,
  };
}

// ============================================================
//  Valyuta (Q15): so'm — asosiy, dollar — faqat Beds24 broni
// ============================================================

/** Tizim valyutasi — sayt, Shaxmatka, hisobot, bot, maosh, xarajat */
export const BASE_CURRENCY = "UZS";

/** Sayt API javoblaridagi `currency` maydoni — tizim valyutasi */
export const CURRENCY = BASE_CURRENCY;

export function isBaseCurrency(currency: string | null | undefined): boolean {
  return (currency || BASE_CURRENCY).toUpperCase() === BASE_CURRENCY;
}

/**
 * Bron summasini so'mga o'girish koeffitsienti.
 *
 * So'm bron — 1. Dollar bron — bronga yozilgan kurs (bron kelgan kun).
 * Kurs hali yozilmagan bo'lsa (Markaziy bank javob bermagan) — `fallback`
 * (joriy kurs); u ham yo'q bo'lsa `null`: summa o'girilmaydi.
 */
export function baseRate(
  r: { currency?: string | null; exchangeRate?: Num },
  fallback?: number | null
): number | null {
  if (isBaseCurrency(r.currency)) return 1;
  const k = num(r.exchangeRate);
  if (k > 0) return k;
  return fallback && fallback > 0 ? fallback : null;
}

/** Bron valyutasidagi summa -> so'm. Kurs noma'lum bo'lsa o'zgarishsiz */
export function toBase(amount: Num, rate: number | null): number {
  if (rate === null || rate === 1) return round2(amount);
  return round2(num(amount) * rate);
}

/**
 * To'lovning so'mdagi qiymati (kassa hisoboti).
 *
 * So'mda qabul qilingan to'lov — ASL summa (kassaga aynan shu pul
 * tushgan). Dollarda qabul qilingan — bron kursi bilan.
 */
export function paymentBase(
  p: { amount: Num; originalAmount?: Num; originalCurrency?: string | null },
  rate: number | null
): number {
  if (p.originalCurrency && isBaseCurrency(p.originalCurrency) && p.originalAmount != null) {
    return round2(p.originalAmount);
  }
  return toBase(p.amount, rate);
}

// ============================================================
//  Ko'rinish
// ============================================================

/**
 * Summa matni — xato xabarlari, bot, eksport uchun.
 *   UZS: "450 000 so'm" (tiyin ko'rsatilmaydi — so'mda amalda yo'q)
 *   USD: "$1,234.50" (Beds24 broni)
 */
export function formatMoney(v: Num, currency: string = BASE_CURRENCY): string {
  const n = round2(v);
  const cur = currency.toUpperCase();
  if (cur === BASE_CURRENCY) {
    // ru-RU minglik ajratkichi - bo'linmas bo'shliq (U+00A0 / U+202F)
    return Math.round(n).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ") + " so'm";
  }
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "-" : "";
  if (cur === "USD") return `${sign}$${abs}`;
  return `${sign}${abs} ${cur}`;
}
