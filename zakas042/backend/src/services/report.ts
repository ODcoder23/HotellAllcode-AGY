/**
 * Umumiy hisobot — faqat FOUNDER uchun
 *
 * Bir joyda butun biznes: bron, moliya, xona, xodim.
 * `stats.ts` dan FARQI: u kundalik ish uchun (bugungi holat),
 * bu esa davr bo'yicha tahlil (oy, chorak, yil).
 *
 * NEGA ALOHIDA: bu yerda maosh, foyda va xarajat bor — ADMIN
 * texnik ishlarni qiladi, bu raqamlar unga kerak emas
 * (`PERMISSIONS["report.read"] = ["FOUNDER"]`).
 *
 * Hamma summa so'mda; formula — lib/money.ts.
 */

import { prisma } from "../lib/prisma.js";
import { toNumber, toDateKey } from "../lib/serialize.js";
import { reservationMoney, round2, stayRevenueIn, sumMoney } from "../lib/money.js";
import { expenseSummary, CATEGORY_LABEL } from "./expenses.js";

// ============================================================
//  Yordamchi
// ============================================================

const ACTIVE_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] as const;

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// ============================================================
//  Turlar
// ============================================================

export type BookingReport = {
  total: number;
  /** Status bo'yicha: confirmed, checked_in, cancelled... */
  byStatus: Array<{ status: string; count: number }>;
  /** Manba bo'yicha: sayt, Booking.com, telefon... */
  bySource: Array<{ source: string; count: number; revenue: number }>;
  /** Tarif bo'yicha: qaysi xona turi ko'p sotiladi */
  byRoomType: Array<{ typeId: string; label: string; count: number; nights: number; revenue: number }>;
  /** O'rtacha qancha kecha qolishadi */
  avgNights: number;
  /** Bekor qilingan / jami (foizda) */
  cancellationRate: number;
};

export type MoneyReport = {
  /** Xona — davrga tushgan kechalar bo'yicha */
  roomRevenue: number;
  /** Nonushta — davrga tushgan kechalar bo'yicha */
  mealRevenue: number;
  /** Qo'shimcha xizmatlar — qo'shilgan sanasi davrda */
  charges: number;
  /** Davrda bekor qilingan bronlar jarimasi */
  cancellationFees: number;
  /** room + meal + charges + cancellationFees */
  totalRevenue: number;
  /** Davrda kassaga kelgan pul (qaytarishlar ayirilgan) */
  paid: number;
  /** Davrdagi bronlarning to'lanmagan qoldig'i (bron bo'yicha, to'liq) */
  debt: number;
  /** Xodimlar oylik maoshi (davr uchun hisoblangan) */
  salaryExpense: number;
  /**
   * Boshqa xarajatlar (SAVOLLAR.md S14): kommunal, oziq-ovqat,
   * soliq, reklama va OTA komissiyasi. Maosh bu yerga KIRMAYDI —
   * u `salaryExpense` da alohida.
   */
  otherExpenses: number;
  /** Xarajat turlari bo'yicha taqsimot */
  expenseBreakdown: Array<{ category: string; label: string; amount: number }>;
  /** salaryExpense + otherExpenses */
  totalExpenses: number;
  /**
   * totalRevenue - totalExpenses
   *
   * DIQQAT: 2026-09-17 gacha bu faqat maoshni ayirardi, shuning
   * uchun foyda haqiqatdan katta ko'rinardi (ayniqsa OTA
   * komissiyasi hisobga olinmagani uchun).
   */
  grossProfit: number;
  /** To'lov usuli bo'yicha: naqd, karta, onlayn */
  byMethod: Array<{ method: string; count: number; amount: number }>;
};

export type OccupancyReport = {
  /** Davrdagi jami (xona × kun) */
  roomNights: number;
  /** Sotilgan (xona × kun) */
  soldNights: number;
  /** Yopiq (ta'mir) */
  blockedNights: number;
  occupancyPercent: number;
  /** O'rtacha kunlik narx — ADR (Average Daily Rate) */
  adr: number;
  /** Mavjud xona boshiga daromad — RevPAR */
  revpar: number;
};

export type StaffReport = {
  total: number;
  active: number;
  /** Lavozim bo'yicha taqsimot */
  byPosition: Array<{ position: string; count: number; salaryTotal: number }>;
  monthlySalary: number;
  /** Tizimga kira oladigan hisoblar */
  systemUsers: Array<{ role: string; count: number }>;
};

export type FullReport = {
  from: string;
  to: string;
  days: number;
  bookings: BookingReport;
  money: MoneyReport;
  occupancy: OccupancyReport;
  staff: StaffReport;
};

// ============================================================
//  1. Bronlar
// ============================================================

async function bookingReport(from: Date, toEx: Date): Promise<BookingReport> {
  const rows = await prisma.reservation.findMany({
    where: { checkIn: { gte: from, lt: toEx } },
    select: {
      status: true, source: true, checkIn: true, checkOut: true,
      adults: true, children: true,
      pricePerNight: true, withMeal: true, mealPricePerPerson: true,
      cancellationFee: true,
      room: { select: { roomTypeId: true, roomType: { select: { label: true } } } },
      charges: { select: { amount: true } },
    },
  });

  const byStatus = new Map<string, number>();
  const bySource = new Map<string, { count: number; revenue: number }>();
  const byType = new Map<string, { label: string; count: number; nights: number; revenue: number }>();

  let totalNights = 0;
  let cancelled = 0;
  let active = 0;

  for (const r of rows) {
    const st = r.status.toLowerCase();
    byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
    if (r.status === "CANCELLED") cancelled++;

    // Bekor qilinganlar kecha/tur statistikasiga kirmaydi, lekin
    // jarimasi manba daromadida bor (lib/money.ts: summa = jarima)
    const m = reservationMoney(r);
    const src = r.source.toLowerCase();
    if (!ACTIVE_STATUSES.includes(r.status as never)) {
      if (m.total > 0) {
        const cur = bySource.get(src) ?? { count: 0, revenue: 0 };
        bySource.set(src, { count: cur.count, revenue: sumMoney([cur.revenue, m.total]) });
      }
      continue;
    }

    const n = m.nights;
    const rev = m.total;   // xona + nonushta + xizmatlar

    active++;
    totalNights += n;

    const curSrc = bySource.get(src) ?? { count: 0, revenue: 0 };
    bySource.set(src, { count: curSrc.count + 1, revenue: sumMoney([curSrc.revenue, rev]) });

    const tid = r.room.roomTypeId;
    const curType = byType.get(tid) ?? { label: r.room.roomType.label, count: 0, nights: 0, revenue: 0 };
    byType.set(tid, {
      label: curType.label,
      count: curType.count + 1,
      nights: curType.nights + n,
      revenue: sumMoney([curType.revenue, rev]),
    });
  }

  // O'rtacha kecha — faqat faol bronlar bo'yicha: kelmaganlar kechasi
  // sanalmaydi, ular maxrajga ham kirmasin (ilgari `jami - bekor` edi)
  return {
    total: rows.length,
    byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    bySource: [...bySource.entries()].map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.revenue - a.revenue),
    byRoomType: [...byType.entries()].map(([typeId, v]) => ({ typeId, ...v }))
      .sort((a, b) => b.revenue - a.revenue),
    avgNights: active > 0 ? Math.round((totalNights / active) * 10) / 10 : 0,
    cancellationRate: rows.length > 0 ? Math.round((cancelled / rows.length) * 1000) / 10 : 0,
  };
}

// ============================================================
//  2. Pul
// ============================================================

async function moneyReport(from: Date, toEx: Date, days: number): Promise<MoneyReport> {
  /**
   * 2026-09-25 QAYTA YOZILDI ("barcha hisob-kitoblar
   * mukammal bo'lsin"). Ilgari:
   *   - nonushta va bekor qilish jarimasi daromadga kirmasdi;
   *   - davr bilan kesishgan har bronning BARCHA qo'shimcha xizmatlari
   *     sanalardi — oy oxiridagi bron ikki oyda ikki marta chiqardi;
   *   - "qarz" = davr daromadi - davrda kelgan pul edi (oldindan
   *     to'lov bo'lsa qarz yo'qolib, yo'q bo'lsa bo'rtib chiqardi);
   *   - davrda to'lov bo'lmasa boshqa davrlarning to'lovi olinardi.
   * Endi formula lib/money.ts dan olinadi.
   */
  const [active, cancelled, periodCharges, periodPayments] = await Promise.all([
    // Davr bilan kesishgan faol bronlar — xona va nonushta kechalar bo'yicha
    prisma.reservation.findMany({
      where: {
        checkIn: { lt: toEx },
        checkOut: { gt: from },
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: {
        checkIn: true, checkOut: true, adults: true, children: true,
        pricePerNight: true, withMeal: true, mealPricePerPerson: true,
        status: true, cancellationFee: true,
        charges: { select: { amount: true } },
        payments: { select: { amount: true } },
      },
    }),
    // Davrda bekor qilingan — jarima shu davr daromadi
    prisma.reservation.findMany({
      where: {
        status: { in: ["CANCELLED", "NO_SHOW"] },
        OR: [
          { cancelledAt: { gte: from, lt: toEx } },
          { cancelledAt: null, updatedAt: { gte: from, lt: toEx } },
        ],
      },
      select: {
        checkIn: true, checkOut: true, adults: true, children: true,
        pricePerNight: true, withMeal: true, mealPricePerPerson: true,
        status: true, cancellationFee: true,
        payments: { select: { amount: true } },
      },
    }),
    // Qo'shimcha xizmatlar — qo'shilgan sanasi bo'yicha (faqat faol bronda)
    prisma.charge.findMany({
      where: {
        createdAt: { gte: from, lt: toEx },
        reservation: { status: { in: [...ACTIVE_STATUSES] } },
      },
      select: { amount: true },
    }),
    // Kassaga davrda kelgan pul (qaytarishlar manfiy)
    prisma.payment.findMany({
      where: { paymentDate: { gte: from, lt: toEx } },
      select: { amount: true, method: true },
    }),
  ]);

  const room: number[] = [];
  const meal: number[] = [];
  const debts: number[] = [];

  for (const r of active) {
    const part = stayRevenueIn(r, from, toEx);
    room.push(part.room);
    meal.push(part.meal);
    debts.push(reservationMoney(r).remaining);
  }

  const fees: number[] = [];
  for (const r of cancelled) {
    const m = reservationMoney(r);
    fees.push(m.cancellationFee);
    debts.push(m.remaining);
  }

  // Kassa — davrda tushgan pul (qaytarishlar manfiy)
  const byMethod = new Map<string, { count: number; amount: number }>();
  for (const p of periodPayments) {
    const cur = byMethod.get(p.method) ?? { count: 0, amount: 0 };
    byMethod.set(p.method, { count: cur.count + 1, amount: sumMoney([cur.amount, p.amount]) });
  }

  const roomRevenue = sumMoney(room);
  const mealRevenue = sumMoney(meal);
  const charges = sumMoney(periodCharges.map((c) => c.amount));
  const cancellationFees = sumMoney(fees);
  const paid = sumMoney(periodPayments.map((p) => p.amount));

  // Maosh: oylik summa davr uzunligiga moslanadi.
  // 30 kunlik oy deb hisoblanadi — aniq kun soni har oyda farq
  // qiladi, lekin hisobot uchun bu yetarli aniqlik.
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: { salary: true },
  });
  const monthlySalary = sumMoney(employees.map((e) => e.salary));
  const salaryExpense = round2((monthlySalary / 30) * days);

  /**
   * Boshqa xarajatlar (S14) — OTA komissiyasi shu yerda
   * avtomatik qayta hisoblanadi.
   *
   * `SALARY` kategoriyasi chiqarib tashlanadi: maosh
   * `Employee` jadvalidan hisoblanadi va ikki marta
   * qo'shilmasligi kerak.
   */
  const expenses = await expenseSummary(from, toEx);
  const otherExpenses = sumMoney(expenses.byCategory
    .filter((c) => c.category !== "SALARY")
    .map((c) => c.amount));

  const totalRevenue = sumMoney([roomRevenue, mealRevenue, charges, cancellationFees]);
  const totalExpenses = sumMoney([salaryExpense, otherExpenses]);

  return {
    roomRevenue,
    mealRevenue,
    charges,
    cancellationFees,
    totalRevenue,
    paid,
    debt: sumMoney(debts),
    salaryExpense,
    otherExpenses,
    expenseBreakdown: expenses.byCategory
      .filter((c) => c.category !== "SALARY")
      .map((c) => ({
        category: c.category,
        label: CATEGORY_LABEL[c.category],
        amount: c.amount,
      })),
    totalExpenses,
    grossProfit: round2(totalRevenue - totalExpenses),
    byMethod: [...byMethod.entries()].map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amount - a.amount),
  };
}

// ============================================================
//  3. Bandlik
// ============================================================

async function occupancyReport(from: Date, toEx: Date, days: number): Promise<OccupancyReport> {
  const [totalRooms, blocked, reservations] = await Promise.all([
    prisma.room.count({ where: { isActive: true } }),

    // Faqat faol xonalarning yopiq kunlari — `totalRooms` bilan bir o'lchov
    // (ilgari inventardan chiqarilgan xona kunlari ham ayirilardi)
    prisma.roomDayStatus.count({
      where: { date: { gte: from, lt: toEx }, isBlocked: true, room: { isActive: true } },
    }),

    // Davr bilan kesishadigan bronlar
    prisma.reservation.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        checkIn: { lt: toEx },
        checkOut: { gt: from },
      },
      select: {
        checkIn: true, checkOut: true, adults: true, children: true,
        pricePerNight: true, withMeal: true, mealPricePerPerson: true,
      },
    }),
  ]);

  // Faqat davr ichidagi kechalarni sanaymiz — bron davrdan
  // tashqariga chiqishi mumkin. ADR/RevPAR — soha standarti bo'yicha
  // faqat XONA daromadi (nonushta va xizmatlarsiz).
  let soldNights = 0;
  const revenue: number[] = [];

  for (const r of reservations) {
    const part = stayRevenueIn(r, from, toEx);
    soldNights += part.nights;
    revenue.push(part.room);
  }
  const roomRevenue = sumMoney(revenue);

  const roomNights = totalRooms * days;
  const available = Math.max(0, roomNights - blocked);

  return {
    roomNights,
    soldNights,
    blockedNights: blocked,
    occupancyPercent: available > 0 ? Math.round((soldNights / available) * 1000) / 10 : 0,
    adr: soldNights > 0 ? round2(roomRevenue / soldNights) : 0,
    revpar: available > 0 ? round2(roomRevenue / available) : 0,
  };
}

// ============================================================
//  4. Xodimlar
// ============================================================

async function staffReport(): Promise<StaffReport> {
  const [employees, users] = await Promise.all([
    prisma.employee.findMany({
      select: { position: true, salary: true, isActive: true },
    }),
    prisma.user.groupBy({
      by: ["role"],
      where: { isActive: true },
      _count: true,
    }),
  ]);

  const byPosition = new Map<string, { count: number; salaryTotal: number }>();
  let monthlySalary = 0;

  for (const e of employees) {
    if (!e.isActive) continue;
    const sal = toNumber(e.salary);
    monthlySalary = sumMoney([monthlySalary, sal]);
    const cur = byPosition.get(e.position) ?? { count: 0, salaryTotal: 0 };
    byPosition.set(e.position, { count: cur.count + 1, salaryTotal: sumMoney([cur.salaryTotal, sal]) });
  }

  return {
    total: employees.length,
    active: employees.filter((e) => e.isActive).length,
    byPosition: [...byPosition.entries()].map(([position, v]) => ({ position, ...v }))
      .sort((a, b) => b.count - a.count),
    monthlySalary,
    systemUsers: users.map((u) => ({ role: u.role, count: u._count })),
  };
}

// ============================================================
//  Umumiy hisobot
// ============================================================

/**
 * Davr bo'yicha to'liq hisobot.
 *
 * `from` va `to` ikkalasi ham kiradi (inclusive).
 */
export async function getFullReport(from: Date, to: Date): Promise<FullReport> {
  const toEx = addDays(to, 1);
  const days = Math.max(1, Math.round((toEx.getTime() - from.getTime()) / 86_400_000));

  const [bookings, money, occupancy, staff] = await Promise.all([
    bookingReport(from, toEx),
    moneyReport(from, toEx, days),
    occupancyReport(from, toEx, days),
    staffReport(),
  ]);

  return {
    from: toDateKey(from) ?? "",
    to: toDateKey(to) ?? "",
    days,
    bookings,
    money,
    occupancy,
    staff,
  };
}
