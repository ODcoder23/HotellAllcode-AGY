/**
 * Mehmonxona tuzilmasi — tariflar, xonalar, qavatlar (YAGONA MANBA)
 *
 * Manba: mijoz yuborgan ro'yxat (2026-09-16) — 18 xona (3 qavat x 6),
 * 9 tarif. Room.id = xona raqami (mijoz qarori Q2).
 *
 * Ikki joy ishlatadi:
 *   prisma/seed.ts          — test/dev bazasi (namuna bronlar bilan)
 *   src/cli/bootstrap.ts    — production'ning bo'sh bazasi (faqat tuzilma)
 *
 * Ilgari ro'yxat faqat seed ichida edi va production uchun seed'ni
 * ishga tushirishga to'g'ri kelardi — u esa namuna bronlar, soxta
 * xodimlar va standart parolli 4 ta hisob ham yaratardi.
 *
 * `check-docs.sh` shu fayldan 18 xona / 9 tarifni sanaydi — qatorlar
 * shaklini o'zgartirmang.
 */

import type { PrismaClient } from "@prisma/client";

export type HotelRoomType = {
  id: string;
  label: string;
  /** Shaxmatkadagi koeffitsient — haqiqiy narx `RatePlan` dan */
  multiplier: number;
  /** Sayt qidiruvida filtr ("Максимальное количество взрослых") */
  maxAdults: number;
  sortOrder: number;
  /** Namunaviy narx (so'm) — faqat seed; production'da admin yoki Beds24 */
  price: number;
};

export const HOTEL_ROOM_TYPES: HotelRoomType[] = [
  { id: "standard3",  label: "Standart 3 kishilik",         multiplier: 1.0,  maxAdults: 3, sortOrder: 1, price: 400_000 },
  { id: "comfort3",   label: "Komfort 3 kishilik",          multiplier: 1.12, maxAdults: 3, sortOrder: 2, price: 450_000 },
  { id: "semilux",    label: "Oilaviy yarim lyuks",         multiplier: 1.25, maxAdults: 3, sortOrder: 3, price: 500_000 },
  { id: "comfort4",   label: "Komfort 4 kishilik",          multiplier: 1.38, maxAdults: 4, sortOrder: 4, price: 550_000 },
  { id: "premium4",   label: "Premium 4 kishilik",          multiplier: 1.5,  maxAdults: 4, sortOrder: 5, price: 600_000 },
  { id: "deluxe4",    label: "Delyuks 4 kishilik",          multiplier: 1.63, maxAdults: 4, sortOrder: 6, price: 650_000 },
  { id: "famdeluxe",  label: "Oilaviy Delyuks",             multiplier: 1.75, maxAdults: 3, sortOrder: 7, price: 700_000 },
  { id: "famlux201",  label: "Oilaviy lyuks balkonli 201",  multiplier: 2.0,  maxAdults: 4, sortOrder: 8, price: 800_000 },
  { id: "famlux301",  label: "Oilaviy lyuks balkonli 301",  multiplier: 2.0,  maxAdults: 3, sortOrder: 9, price: 800_000 },
];

/** [xona raqami, tarif, qavat] */
export const HOTEL_ROOMS: Array<[string, string, number]> = [
  // 1-qavat
  ["101", "comfort3",  1], ["102", "standard3", 1], ["103", "comfort4",  1],
  ["104", "premium4",  1], ["105", "semilux",   1], ["106", "deluxe4",   1],
  // 2-qavat
  ["201", "famlux201", 2], ["202", "comfort3",  2], ["203", "premium4",  2],
  ["204", "premium4",  2], ["205", "famdeluxe", 2], ["206", "deluxe4",   2],
  // 3-qavat
  ["301", "famlux301", 3], ["302", "comfort3",  3], ["303", "premium4",  3],
  ["304", "comfort4",  3], ["305", "semilux",   3], ["306", "deluxe4",   3],
];

export const EXPECTED_ROOMS = 18;

/**
 * Yaxlitlik: jami son kutilganiga teng, har tarifda xona bor, noma'lum
 * tarif yo'q. Ro'yxat qo'lda tahrirlanganda xato darhol ko'rinadi.
 */
export function assertHotelLayout(): void {
  if (HOTEL_ROOMS.length !== EXPECTED_ROOMS) {
    throw new Error(`Xona soni mos emas! Kutilgan ${EXPECTED_ROOMS}, olindi ${HOTEL_ROOMS.length}`);
  }
  const used = new Set(HOTEL_ROOMS.map(([, t]) => t));
  const empty = HOTEL_ROOM_TYPES.filter((rt) => !used.has(rt.id));
  if (empty.length > 0) throw new Error(`Bu tariflarda xona yo'q: ${empty.map((t) => t.id).join(", ")}`);
  const unknown = [...used].filter((t) => !HOTEL_ROOM_TYPES.some((rt) => rt.id === t));
  if (unknown.length > 0) throw new Error(`Noma'lum tarif ishlatilgan: ${unknown.join(", ")}`);
}

/**
 * Qavat, tarif va xonalarni yaratadi (bo'sh bazaga). Qavat ID'si
 * ("F1") xonalar ro'yxatidan hosil qilinadi.
 */
export async function createHotelStructure(db: PrismaClient): Promise<{ floors: number; roomTypes: number; rooms: number }> {
  assertHotelLayout();

  const floorNumbers = [...new Set(HOTEL_ROOMS.map(([, , f]) => f))].sort((a, b) => a - b);
  await db.floor.createMany({
    data: floorNumbers.map((n) => ({ id: `F${n}`, number: n, label: `${n}-qavat`, sortOrder: n })),
    skipDuplicates: true,
  });

  await db.roomType.createMany({
    data: HOTEL_ROOM_TYPES.map(({ price: _price, ...rt }) => rt),
  });

  await db.room.createMany({
    data: HOTEL_ROOMS.map(([number, roomTypeId, floor], i) => ({
      id: number,
      number,
      floor,
      floorId: `F${floor}`,
      roomTypeId,
      status: "AVAILABLE" as const,
      sortOrder: i,
    })),
  });

  return { floors: floorNumbers.length, roomTypes: HOTEL_ROOM_TYPES.length, rooms: HOTEL_ROOMS.length };
}
