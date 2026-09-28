/**
 * Xarajatlar
 *
 * MUAMMO: hisobotda faqat maosh xarajat sifatida hisoblanardi.
 * Kommunal, soliq va ayniqsa OTA komissiyasi (Booking.com 15-18%)
 * hisobga olinmagani uchun foyda haqiqatdan katta ko'rinardi.
 *
 * IKKI MANBA:
 *   1. Qo'lda kiritilgan — kommunal, oziq-ovqat, ta'mir, soliq
 *   2. Avtomatik — OTA komissiyasi, bron manbasidan hisoblanadi
 *
 * Maosh bu yerda EMAS: u `Employee` jadvalidan hisoblanadi
 * (report.ts), chunki oylik summa doimiy va har oy qo'lda
 * kiritish ortiqcha ish bo'lardi.
 */

import { Prisma, type ExpenseCategory, type ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { getOtaCommissionPercent } from "./settings.js";
import { reservationMoney, round2, sumMoney, toBase } from "../lib/money.js";
import { reportRateResolver } from "./exchangeRate.js";

/**
 * Qaysi bron manbalari komissiya oladi.
 *
 * Komissiya YO'Q: `DIRECT`, `WEBSITE`, `PHONE`, `WALK_IN` —
 * mehmon to'g'ridan-to'g'ri keladi, vositachi yo'q.
 *
 * Komissiya BOR: OTA (Online Travel Agency) kanallari — Beds24 orqali
 * keladi yoki qabulxona qo'lda kiritadi (manba "Booking.com" va h.k.).
 * Beds24 API komissiyani bermaydi (real bronlarda 0), shuning uchun
 * sozlamadagi foiz bilan hisoblanadi.
 * `OTHER` bu yerda emas — u noaniq manba, komissiya
 * olinayotganiga ishonch yo'q.
 */
export const OTA_SOURCES: ReadonlySet<ReservationSource> = new Set<ReservationSource>([
  "BOOKING_COM", "AIRBNB", "EXPEDIA", "OSTROVOK",
]);

export type ExpenseInput = {
  date: string;              // "YYYY-MM-DD"
  category: ExpenseCategory;
  amount: number;
  note?: string;
  userId?: string;
};

/** Sana kalitini UTC yarim tuniga aylantiradi (@db.Date bilan mos) */
function toDate(key: string): Date {
  return new Date(key + "T00:00:00.000Z");
}

// ============================================================
//  Qo'lda kiritish
// ============================================================

/**
 * Xarajat qo'shadi.
 *
 * Summa musbat bo'lishi shart: manfiy xarajat "daromad" degani,
 * u alohida yo'l bilan yoziladi.
 */
export async function addExpense(input: ExpenseInput) {
  if (input.amount <= 0) {
    throw new ValidationError("Xarajat summasi musbat bo'lishi kerak");
  }

  // Foydalanuvchi mavjudligini tekshiramiz: dev rejimida soxta
  // `id: "dev"` keladi va foreign key buzilardi
  const userId = input.userId
    ? (await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      }))?.id ?? null
    : null;

  return prisma.expense.create({
    data: {
      date: toDate(input.date),
      category: input.category,
      amount: new Prisma.Decimal(input.amount),
      note: input.note?.trim() || null,
      userId,
      isAuto: false,
    },
  });
}

/**
 * Xarajatni o'chiradi.
 *
 * Avtomatik yozuvlarni (komissiya) qo'lda o'chirib bo'lmaydi —
 * ular keyingi hisoblashda qaytadan paydo bo'lardi va
 * foydalanuvchi buni tushunmasdi.
 */
export async function deleteExpense(id: string) {
  const row = await prisma.expense.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Xarajat");

  if (row.isAuto) {
    throw new ValidationError(
      "Avtomatik hisoblangan xarajatni o'chirib bo'lmaydi " +
      "(komissiya foizini sozlamalardan o'zgartiring)"
    );
  }

  return prisma.expense.delete({ where: { id } });
}

/** Davr bo'yicha ro'yxat */
export async function listExpenses(from: Date, toEx: Date) {
  return prisma.expense.findMany({
    where: { date: { gte: from, lt: toEx } },
    include: { user: { select: { fullName: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
}

// ============================================================
//  OTA komissiyasi — avtomatik
// ============================================================

/** Komissiya qayta hisobi uchun advisory lock kaliti (ixtiyoriy, noyob son) */
const COMMISSION_LOCK_KEY = 7_401_001;

/**
 * Davrdagi OTA komissiyasini qaytadan hisoblaydi.
 *
 * NEGA QAYTA HISOBLASH: bron bekor qilinishi, narxi o'zgarishi
 * yoki komissiya foizi yangilanishi mumkin. Har safar noldan
 * hisoblash eng sodda va eng ishonchli yo'l — oraliq holat
 * saqlanmaydi, demak u eskirib qolmaydi.
 *
 * FAQAT avtomatik yozuvlar o'chiriladi; qo'lda kiritilgan
 * xarajatlarga tegilmaydi.
 */
export async function recalcCommissions(from: Date, toEx: Date): Promise<{
  count: number;
  total: number;
}> {
  const percent = await getOtaCommissionPercent();
  const rateOf = await reportRateResolver();

  const bookings = await prisma.reservation.findMany({
    where: {
      checkIn: { gte: from, lt: toEx },
      source: { in: [...OTA_SOURCES] as ReservationSource[] },
      // Bekor qilingan bron uchun komissiya to'lanmaydi
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      adults: true,
      children: true,
      status: true,
      pricePerNight: true,
      withMeal: true,
      mealPricePerPerson: true,
      currency: true,
      exchangeRate: true,
    },
  });

  /**
   * Komissiya bazasi — OTA'da sotilgan narx: xona + nonushta.
   *
   * 2026-09-25 TUZATISH: ilgari mehmonxonada qo'shilgan xizmatlar
   * (mini-bar, transfer) ham bazaga kirardi — OTA ulardan komissiya
   * olmaydi, xarajat bo'rtib chiqardi.
   */
  const rows = bookings
    .map((b) => {
      const m = reservationMoney(b);
      // So'mda: dollar bron (Beds24) — bron kelgan kundagi kurs bilan
      const base = toBase(sumMoney([m.roomTotal, m.mealTotal]), rateOf(b));
      return {
        date: b.checkIn,
        category: "COMMISSION" as ExpenseCategory,
        amount: new Prisma.Decimal(round2((base * percent) / 100)),
        note: `${percent}% komissiya`,
        isAuto: true,
        reservationId: b.id,
      };
    })
    .filter((r) => r.amount.gt(0));

  /**
   * Eski avtomatik yozuvlarni tozalab, yangisini yozamiz — BITTA QULF ostida.
   *
   * 2026-09-26 TUZATISH: hisobot va xarajatlar sahifasi bir vaqtda
   * ochilsa (yoki ikki oyna), ikkala so'rov ham "o'chir + yoz" qilardi.
   * READ COMMITTED da ikkinchi `deleteMany` birinchisi yozgan qatorlarni
   * ko'rmaydi — natijada komissiya ikki marta yozilib, xarajat va foyda
   * buzilardi. `pg_advisory_xact_lock` ikkinchisini birinchisi tugashini
   * kutishga majbur qiladi.
   */
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMISSION_LOCK_KEY}::bigint)`;
    await tx.expense.deleteMany({
      where: { date: { gte: from, lt: toEx }, isAuto: true, category: "COMMISSION" },
    });
    if (rows.length > 0) await tx.expense.createMany({ data: rows });
  });

  return {
    count: rows.length,
    total: sumMoney(rows.map((r) => r.amount)),
  };
}

// ============================================================
//  Hisobot uchun
// ============================================================

export type ExpenseSummary = {
  total: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number; count: number }>;
};

/**
 * Davr bo'yicha xarajat yig'indisi.
 *
 * Komissiya avval qayta hisoblanadi — hisobot ochilganda eng
 * yangi raqamni ko'rsatsin.
 */
export async function expenseSummary(from: Date, toEx: Date): Promise<ExpenseSummary> {
  await recalcCommissions(from, toEx);

  const grouped = await prisma.expense.groupBy({
    by: ["category"],
    where: { date: { gte: from, lt: toEx } },
    _sum: { amount: true },
    _count: true,
  });

  const byCategory = grouped
    .map((g) => ({
      category: g.category,
      amount: round2(g._sum.amount),
      count: g._count,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    total: sumMoney(byCategory.map((c) => c.amount)),
    byCategory,
  };
}

/** Kategoriya nomlari — panel va hisobot uchun */
export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  UTILITIES: "Kommunal",
  FOOD: "Oziq-ovqat",
  MAINTENANCE: "Ta'mir va jihoz",
  TAX: "Soliq",
  MARKETING: "Reklama",
  COMMISSION: "OTA komissiyasi",
  SALARY: "Maosh",
  OTHER: "Boshqa",
};
