/**
 * API serializatsiya qatlami
 *
 * Manba: 02-DATABASE-SXEMA.md §3 — Shaxmatka moslik jadvali
 *
 * YAGONA JOY. Har controllerda alohida konvertatsiya yozilmaydi.
 * Prisma `Decimal` obyekt qaytaradi, frontend esa son kutadi
 * (`p.amount` ustida `reduce` qiladi) — shu yerda o'giriladi.
 */

import { reservationMoney } from "./money.js";
import type { Prisma } from "@prisma/client";

// --- Ibtidoiy konvertorlar ----------------------------------

/** Prisma Decimal | number | string → number */
export const toNumber = (v: Prisma.Decimal | number | string | null): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v.toString());
};

/** DateTime → "YYYY-MM-DD" (Shaxmatka toKey() bilan bir xil) */
export const toDateKey = (d: Date | null): string | null => {
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** "YYYY-MM-DD" → Date (UTC yarim tunda, vaqt zonasi siljishisiz) */
export const fromDateKey = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/**
 * Haqiqiy kalendar sanasimi: "2026-02-31" shaklan to'g'ri, lekin
 * `Date.UTC` uni jimgina 3-martga aylantiradi. Qaytarib yozilganda
 * bir xil chiqsagina sana to'g'ri.
 */
export const isValidDateKey = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && toDateKey(fromDateKey(s)) === s;

/** BOOKING_COM → "booking_com" (frontend SOURCES kaliti) */
export const enumToKey = (e: string): string => e.toLowerCase();

/** "booking_com" → BOOKING_COM */
export const keyToEnum = (k: string): string => k.toUpperCase();

// --- Room ---------------------------------------------------

type RoomRow = {
  id: string;
  number: string;
  floor: number;
  floorId?: string | null;
  roomTypeId: string;
  status: string;
  isActive: boolean;
  sortOrder: number;
};

/**
 * Shaxmatka `rooms` massivi elementi:
 *   { id, number, type, floor, status }
 *
 * `floorId` qo'shildi (2026-09-16): qavatning o'z ID'si barcha
 * tizimlarga bir xil qiymat bo'lib tarqaladi. Shaxmatka uni hozircha
 * ishlatmaydi va e'tiborsiz qoldiradi — `floor` (son) o'z joyida
 * qolgani uchun mavjud kod o'zgarmaydi.
 */
export function serializeRoom(r: RoomRow) {
  return {
    id: r.id,                      // "101" — Q2
    number: r.number,
    type: r.roomTypeId,            // "standard"
    floor: r.floor,
    floorId: r.floorId ?? null,    // "F1"
    status: enumToKey(r.status),   // "available"
    // Frontendda yo'q, e'tiborsiz qoldiriladi:
    isActive: r.isActive,
    sortOrder: r.sortOrder,
  };
}

// --- Floor --------------------------------------------------

type FloorRow = {
  id: string;
  number: number;
  label: string;
  isActive: boolean;
  sortOrder: number;
};

export const serializeFloor = (f: FloorRow) => ({
  id: f.id,           // "F1" — barcha tizimlarda shu qiymat
  number: f.number,   // 1
  label: f.label,     // "1-qavat"
  isActive: f.isActive,
  sortOrder: f.sortOrder,
});

// --- Charge / Payment ---------------------------------------

type ChargeRow = { id: string; label: string; amount: Prisma.Decimal };
type PaymentRow = {
  id: string;
  amount: Prisma.Decimal;
  method: string;
  paymentDate: Date;
  note: string | null;
};

export const serializeCharge = (c: ChargeRow) => ({
  id: c.id,
  label: c.label,
  amount: toNumber(c.amount),
});

export const serializePayment = (p: PaymentRow) => ({
  id: p.id,
  amount: toNumber(p.amount),        // so'm; manfiy — qaytarish
  method: p.method,
  date: toDateKey(p.paymentDate),   // frontend `p.date` kutadi
  note: p.note ?? "",
});

// --- Reservation --------------------------------------------

type ReservationRow = {
  id: string;
  roomId: string;
  guest: { fullName: string; phone: string | null; email: string | null };
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  source: string;
  pricePerNight: Prisma.Decimal;
  notes: string | null;
  withMeal: boolean;
  mealPricePerPerson?: Prisma.Decimal | null;
  cancellationFee?: Prisma.Decimal | null;
  priceReason?: string | null;
  status: string;
  code?: string | null;
  externalReference?: string | null;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  createdAt: Date;
  charges?: ChargeRow[];
  payments?: PaymentRow[];
};

/**
 * Shaxmatka `reservations` massivi elementi.
 *
 * Muhim: `guest` obyekti FLATTEN qilinadi — frontend `res.guestName`
 * va `res.phone` kutadi, ichma-ich obyekt emas.
 */
export function serializeReservation(r: ReservationRow) {
  const charges = (r.charges ?? []).map(serializeCharge);
  const payments = (r.payments ?? []).map(serializePayment);

  /**
   * TZ 14-band formulasi — `lib/money.ts` (YAGONA MANBA).
   *
   * Nonushta (S10): kishi boshiga, har kecha; narx BRONDAN olinadi.
   * Bekor qilingan / kelmagan bron (S11): summa = faqat jarima.
   * Hammasi tiyinda qo'shiladi — float qoldig'i yo'q.
   */
  const m = reservationMoney(r);

  return {
    id: r.id,
    roomId: r.roomId,
    guestName: r.guest.fullName,          // flatten
    phone: r.guest.phone ?? "",           // flatten
    checkIn: toDateKey(r.checkIn),
    checkOut: toDateKey(r.checkOut),
    adults: r.adults,
    children: r.children,
    source: enumToKey(r.source),          // "booking_com"
    pricePerNight: toNumber(r.pricePerNight),
    nights: m.nights,
    roomTotal: m.roomTotal,
    notes: r.notes ?? "",
    withMeal: r.withMeal,
    // Nonushta tafsiloti — Shaxmatka hisobni ko'rsatishi uchun
    mealPricePerPerson: m.mealPricePerPerson,
    mealTotal: m.mealTotal,
    // Bekor qilish jarimasi (0 bo'lsa bepul bekor qilingan)
    cancellationFee: m.cancellationFee,
    priceReason: r.priceReason ?? "",
    status: enumToKey(r.status),          // "pending_payment" (Q5)
    charges,
    payments,
    createdAt: r.createdAt.getTime(),     // epoch ms

    // Hisoblangan (TZ 14-band) — frontend o'zi ham hisoblaydi,
    // lekin API tayyor qaytaradi
    totalPrice: m.total,
    paidAmount: m.paid,
    remainingAmount: m.remaining,
    refundDue: m.refundDue,

    // Sayt broni kodi (IMR-XXXXX) — qabulxona mehmon bilan gaplashganda
    code: r.code ?? null,
    // OTA bron raqami — Shaxmatka faqat founder'ga ko'rsatadi (kanal kuzatuvi)
    externalReference: r.externalReference ?? null,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
  };
}

// --- RoomType -----------------------------------------------

type RoomTypeRow = {
  id: string;
  label: string;
  multiplier: number;
  maxAdults: number;
  sortOrder: number;
};

/**
 * `maxAdults` qo'shildi (2026-09-16): admin panel "Maks. odam"
 * ustunini shu maydondan oladi. Shaxmatka uni e'tiborsiz
 * qoldiradi — qo'shimcha maydon zarar qilmaydi.
 */
export const serializeRoomType = (t: RoomTypeRow) => ({
  id: t.id,
  label: t.label,
  multiplier: t.multiplier,
  maxAdults: t.maxAdults,
  sortOrder: t.sortOrder,
});
