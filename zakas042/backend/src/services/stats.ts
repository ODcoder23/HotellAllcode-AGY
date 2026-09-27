/**
 * Hisobot va statistika
 *
 * Telegram bot va admin panel uchun umumiy qatlam. Ikkalasi bir xil
 * raqamni ko'rsatishi shart — aks holda "botda boshqa, panelda
 * boshqa" degan savol chiqadi.
 *
 * NEGA ALOHIDA FAYL: bu yerda faqat O'QISH bor, hech narsa
 * o'zgarmaydi. Shuning uchun `reservations.ts` (biznes amallar)
 * ichiga aralashtirilmadi.
 *
 * "Bugun" — mehmonxona (Toshkent) kuni, `lib/hotelTime.ts`.
 */

import { prisma } from "../lib/prisma.js";
import { toDateKey } from "../lib/serialize.js";
import { reservationMoney, sumMoney } from "../lib/money.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";

/** Bron xonani band qiladigan statuslar */
const ACTIVE_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] as const;

// ============================================================
//  1. Bugungi holat (Dashboard)
// ============================================================

export type TodaySnapshot = {
  date: string;
  /** Bugun kirishi kerak bo'lgan bronlar */
  arrivals: number;
  /** Bugun chiqishi kerak bo'lganlar */
  departures: number;
  /** Hozir xonada turgan mehmonlar */
  staying: number;
  totalRooms: number;
  occupiedRooms: number;
  freeRooms: number;
  /** Ta'mir yoki xizmatdan chiqarilgan (bugungi kun) */
  blockedRooms: number;
  occupancyPercent: number;
  /** Bugun boshlangan bronlarning jami summasi */
  todayRevenue: number;
};

export async function getTodaySnapshot(): Promise<TodaySnapshot> {
  const today = hotelToday();

  const [rooms, blocked, arrivals, departures, staying] = await Promise.all([
    prisma.room.count({ where: { isActive: true } }),

    prisma.roomDayStatus.count({
      where: { date: today, isBlocked: true, room: { isActive: true } },
    }),

    prisma.reservation.findMany({
      where: { checkIn: today, status: { in: [...ACTIVE_STATUSES] } },
      select: {
        id: true, checkIn: true, checkOut: true, adults: true, children: true,
        pricePerNight: true, withMeal: true, mealPricePerPerson: true,
        status: true, cancellationFee: true,
        charges: { select: { amount: true } },
      },
    }),

    prisma.reservation.count({
      where: { checkOut: today, status: { in: [...ACTIVE_STATUSES] } },
    }),

    // Hozir xonada: checkIn <= bugun < checkOut
    prisma.reservation.findMany({
      where: {
        checkIn: { lte: today },
        checkOut: { gt: today },
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { roomId: true },
    }),
  ]);

  // Bir xonada bir vaqtda bitta bron bo'ladi (overbooking constraint),
  // lekin ehtiyot uchun noyob sanaymiz.
  const occupiedRooms = new Set(staying.map((r) => r.roomId)).size;

  // Bugun boshlangan bronlarning jami qiymati — bron summasi bilan
  // bir xil (xona + nonushta + xizmatlar, lib/money.ts). Ilgari
  // nonushta kirmasdi va bot panelnikidan kam ko'rsatardi.
  const todayRevenue = sumMoney(arrivals.map((r) => reservationMoney(r).total));

  const freeRooms = Math.max(0, rooms - occupiedRooms - blocked);

  return {
    date: toDateKey(today) ?? "",
    arrivals: arrivals.length,
    departures,
    staying: staying.length,
    totalRooms: rooms,
    occupiedRooms,
    freeRooms,
    blockedRooms: blocked,
    occupancyPercent: rooms > 0 ? Math.round((occupiedRooms / rooms) * 100) : 0,
    todayRevenue,
  };
}

// ============================================================
//  2. Moliya
// ============================================================

export type FinanceReport = {
  from: string;
  to: string;
  /** Oraliqda boshlangan bronlar soni */
  bookings: number;
  /** Xona narxi × kechalar */
  roomRevenue: number;
  /** Nonushta: narx × kishi × kecha */
  mealRevenue: number;
  /** Qo'shimcha xarajatlar (mini-bar, transfer va h.k.) */
  charges: number;
  /** roomRevenue + mealRevenue + charges */
  total: number;
  /** Shu bronlar bo'yicha qabul qilingan to'lovlar */
  paid: number;
  /** Shu bronlarning to'lanmagan qoldig'i (bron bo'yicha, manfiy bo'lmaydi) */
  debt: number;
  /** Manba bo'yicha taqsimot */
  bySource: Array<{ source: string; count: number; amount: number }>;
};

/**
 * Oraliq bo'yicha moliyaviy hisobot.
 *
 * `from` va `to` ikkalasi ham kiradi (inclusive). Bron `checkIn`
 * sanasi bo'yicha hisoblanadi — ya'ni "shu kunlarda kelgan
 * mehmonlar qancha pul olib keldi".
 */
export async function getFinanceReport(from: Date, to: Date): Promise<FinanceReport> {
  const toExclusive = addDays(to, 1);

  const reservations = await prisma.reservation.findMany({
    where: {
      checkIn: { gte: from, lt: toExclusive },
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: {
      checkIn: true, checkOut: true, adults: true, children: true,
      pricePerNight: true, withMeal: true, mealPricePerPerson: true,
      status: true, cancellationFee: true,
      source: true,
      charges: { select: { amount: true } },
      payments: { select: { amount: true } },
    },
  });

  // Formula — lib/money.ts (bron kartasi, hisobot va bot bir xil)
  const room: number[] = [];
  const meal: number[] = [];
  const extra: number[] = [];
  const paidAll: number[] = [];
  const debts: number[] = [];
  const bySource = new Map<string, { count: number; amount: number }>();

  for (const r of reservations) {
    const m = reservationMoney(r);
    room.push(m.roomTotal);
    meal.push(m.mealTotal);
    extra.push(m.chargesTotal);
    paidAll.push(m.paid);
    debts.push(m.remaining);

    const key = r.source.toLowerCase();
    const cur = bySource.get(key) ?? { count: 0, amount: 0 };
    bySource.set(key, { count: cur.count + 1, amount: sumMoney([cur.amount, m.total]) });
  }

  const roomRevenue = sumMoney(room);
  const mealRevenue = sumMoney(meal);
  const charges = sumMoney(extra);
  const total = sumMoney([roomRevenue, mealRevenue, charges]);

  return {
    from: toDateKey(from) ?? "",
    to: toDateKey(to) ?? "",
    bookings: reservations.length,
    roomRevenue,
    mealRevenue,
    charges,
    total,
    paid: sumMoney(paidAll),
    debt: sumMoney(debts),
    bySource: [...bySource.entries()]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** Bugun / shu hafta / shu oy uchun tayyor oraliqlar */
export function periodRange(period: "today" | "week" | "month"): { from: Date; to: Date } {
  const today = hotelToday();

  if (period === "today") return { from: today, to: today };

  if (period === "week") {
    // Dushanbadan boshlanadi (O'zbekistonda hafta shunday)
    const dow = today.getUTCDay();          // 0 = yakshanba
    const backToMonday = dow === 0 ? 6 : dow - 1;
    return { from: addDays(today, -backToMonday), to: today };
  }

  // month
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return { from: first, to: today };
}

// ============================================================
//  3. Xona holati
// ============================================================

export type RoomStateRow = {
  id: string;
  floor: number;
  typeId: string;
  typeLabel: string;
  /** Xonaning jismoniy holati (`Room.status`) */
  status: string;
  /** Bugun mehmon bormi */
  occupied: boolean;
  /** Bugun ta'mir/yopiq */
  blocked: boolean;
  /** Mehmon ismi — band bo'lsa */
  guestName?: string;
  /** Qachon chiqadi — band bo'lsa */
  until?: string;
};

export async function getRoomStates(): Promise<RoomStateRow[]> {
  const today = hotelToday();

  const [rooms, staying, blocked] = await Promise.all([
    prisma.room.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      include: { roomType: { select: { label: true } } },
    }),

    prisma.reservation.findMany({
      where: {
        checkIn: { lte: today },
        checkOut: { gt: today },
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { roomId: true, checkOut: true, guest: { select: { fullName: true } } },
    }),

    prisma.roomDayStatus.findMany({
      where: { date: today, isBlocked: true },
      select: { roomId: true },
    }),
  ]);

  const byRoom = new Map(staying.map((r) => [r.roomId, r]));
  const blockedIds = new Set(blocked.map((b) => b.roomId));

  return rooms.map((r) => {
    const res = byRoom.get(r.id);
    return {
      id: r.id,
      floor: r.floor,
      typeId: r.roomTypeId,
      typeLabel: r.roomType.label,
      status: r.status.toLowerCase(),
      occupied: !!res,
      blocked: blockedIds.has(r.id),
      guestName: res?.guest.fullName,
      until: res ? toDateKey(res.checkOut) ?? undefined : undefined,
    };
  });
}

// ============================================================
//  4. Yaqin bronlar
// ============================================================

export type UpcomingBooking = {
  id: string;
  roomId: string;
  guestName: string;
  phone: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  source: string;
  status: string;
  /** So'mda */
  total: number;
  createdAt: string;
};

/** Oxirgi yaratilgan bronlar — bot "so'nggi bronlar" uchun */
export async function getRecentBookings(limit = 10): Promise<UpcomingBooking[]> {
  const rows = await prisma.reservation.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 50),
    select: {
      id: true, roomId: true, checkIn: true, checkOut: true, adults: true, children: true,
      pricePerNight: true, withMeal: true, mealPricePerPerson: true,
      status: true, cancellationFee: true,
      source: true, createdAt: true,
      guest: { select: { fullName: true, phone: true } },
      charges: { select: { amount: true } },
    },
  });

  return rows.map((r) => {
    const m = reservationMoney(r);
    return {
      id: r.id,
      roomId: r.roomId,
      guestName: r.guest.fullName,
      phone: r.guest.phone ?? "",
      checkIn: toDateKey(r.checkIn) ?? "",
      checkOut: toDateKey(r.checkOut) ?? "",
      nights: m.nights,
      source: r.source.toLowerCase(),
      status: r.status.toLowerCase(),
      total: m.total,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
