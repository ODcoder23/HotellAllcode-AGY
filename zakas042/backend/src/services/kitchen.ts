/**
 * Oshxona — nonushta hisobi
 *
 * MAQSAD: oshpazlar ertalab qancha porsiya tayyorlashni bilsin.
 *
 * QOIDA (2026-09-28, egasi tasdiqladi): nonushta tunashdan keyingi
 * ertalab beriladi. D kuni nonushta — D dan oldingi kechani mehmonxonada
 * o'tkazganlarga: `checkIn < D <= checkOut`.
 *   - kelgan kuni nonushta YO'Q (mehmon kunduzi keladi)
 *   - ketadigan kuni nonushta BOR (oxirgi kecha uchun)
 * Nonushtalar soni kecha soniga teng — bron summasi (`lib/money.ts`,
 * narx × kishi × kecha) shu bilan mos.
 *
 * Ilgari teskari edi: kelgan kuni sanalar, ketadigan kuni sanalmasdi.
 *
 * KIM SANALADI (`withMeal = true`):
 *   - xonada (`CHECKED_IN`)
 *   - hali kirish belgilanmagan (`CONFIRMED`, `PENDING_PAYMENT`):
 *     ertangi hisobotda — bugun keladiganlar
 *   - shu kuni chiqib ketgan (`CHECKED_OUT`, chiqish vaqti D kuni):
 *     ertalab nonushta qilgan. Muddatidan oldin ketgan mehmon keyingi
 *     kunlarga sanalmaydi
 *
 * BOLALAR: alohida sanaladi, porsiya va narx bir xil.
 */

import { prisma } from "../lib/prisma.js";
import { addDays, hotelToday, HOTEL_UTC_OFFSET_HOURS } from "../lib/hotelTime.js";

/**
 * Xona holati nonushta kuni:
 *   staying   — xonada, keyingi kun ham qoladi
 *   departing — shu kuni ketadi (oxirgi nonushta)
 *   arriving  — kirish hali belgilanmagan (kutilmoqda)
 */
export type MealState = "staying" | "departing" | "arriving";

export type RoomMeals = {
  roomId: string;
  roomLabel: string;
  adults: number;
  children: number;
  guestName: string;
  /** "Sayt", "Qabulxona", "Booking.com" */
  source: string;
  state: MealState;
  /** `state === "arriving"` — eski mijozlar uchun */
  arriving: boolean;
};

export type KitchenReport = {
  date: string;
  totalGuests: number;
  totalAdults: number;
  totalChildren: number;
  /** Xonada, qoladi */
  staying: number;
  /** Shu kuni ketadi */
  departing: number;
  /** Kirish hali belgilanmagan */
  arriving: number;
  rooms: RoomMeals[];
};

/** Bron manbai nomlari — oshpazga tushunarli bo'lsin */
const SOURCE_LABEL: Record<string, string> = {
  DIRECT: "Qabulxona",
  WEBSITE: "Sayt",
  BOOKING_COM: "Booking.com",
  AIRBNB: "Airbnb",
  EXPEDIA: "Expedia",
  OSTROVOK: "Ostrovok",
  PHONE: "Telefon",
  WALK_IN: "Kelgan mehmon",
  OTHER: "Boshqa",
};

/**
 * Berilgan kun uchun nonushta hisoboti.
 *
 * `offset = 0` bugun, `1` ertaga.
 */
export async function kitchenReport(offset = 0): Promise<KitchenReport> {
  // `@db.Date` bilan solishtirish uchun (Toshkent kuni, UTC 00:00)
  const day = addDays(hotelToday(), offset);
  // Shu kun Toshkentda boshlangan lahza — `checkedOutAt` uchun
  const dayStartInstant = new Date(day.getTime() - HOTEL_UTC_OFFSET_HOURS * 3_600_000);

  const rows = await prisma.reservation.findMany({
    where: {
      withMeal: true,
      checkIn: { lt: day },
      checkOut: { gte: day },
      OR: [
        { status: { in: ["CHECKED_IN", "CONFIRMED", "PENDING_PAYMENT"] } },
        { status: "CHECKED_OUT", checkedOutAt: { gte: dayStartInstant } },
      ],
    },
    select: {
      roomId: true,
      adults: true,
      children: true,
      status: true,
      source: true,
      checkOut: true,
      guest: { select: { fullName: true } },
      room: { select: { roomType: { select: { label: true } } } },
    },
    orderBy: { roomId: "asc" },
  });

  const rooms: RoomMeals[] = rows.map((r) => {
    const state: MealState =
      r.status === "CONFIRMED" || r.status === "PENDING_PAYMENT" ? "arriving"
        : r.status === "CHECKED_OUT" || r.checkOut.getTime() === day.getTime() ? "departing"
          : "staying";
    return {
      roomId: r.roomId,
      roomLabel: r.room.roomType?.label ?? "",
      adults: r.adults,
      children: r.children,
      guestName: r.guest.fullName,
      source: SOURCE_LABEL[r.source] ?? r.source,
      state,
      arriving: state === "arriving",
    };
  });

  const totalAdults = rooms.reduce((s, r) => s + r.adults, 0);
  const totalChildren = rooms.reduce((s, r) => s + r.children, 0);
  const count = (s: MealState) => rooms.filter((r) => r.state === s).length;

  return {
    date: day.toISOString().slice(0, 10),
    totalGuests: totalAdults + totalChildren,
    totalAdults,
    totalChildren,
    staying: count("staying"),
    departing: count("departing"),
    arriving: count("arriving"),
    rooms,
  };
}

/**
 * Bugun va ertaga — panel uchun.
 *
 * Ertangi son oshpazga tayyorgarlik uchun kerak: mahsulot
 * buyurtma qilish, non yopish.
 */
export async function kitchenOverview(): Promise<{
  today: KitchenReport;
  tomorrow: KitchenReport;
}> {
  const [today, tomorrow] = await Promise.all([
    kitchenReport(0),
    kitchenReport(1),
  ]);

  return { today, tomorrow };
}
