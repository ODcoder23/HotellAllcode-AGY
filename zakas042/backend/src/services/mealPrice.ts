/**
 * Nonushta narxi — admin panel "Oshxona" bo'limidan boshqariladi
 * (egasi talabi, 2026-09-25: "o'zgartirilsa butun tizimda
 * hisob-kitoblar o'zgarishi lozim, qolib ketmasligi kerak").
 *
 * NARX QAYERDA ISHLATILADI
 *   - Sayt qidiruvi va sayt broni — har doim JORIY narx (sozlamadan)
 *   - Qabulxona yangi broni — joriy narx bronga ko'chiriladi (S10)
 *   - Bron summasi, qarz, to'lov chegarasi, hisobot, bot, komissiya —
 *     bronga ko'chirilgan narxdan (lib/money.ts)
 *
 * Narx o'zgarganda admin tanlaydi:
 *   applyToActive = false — faqat yangi bronlar (kelishilgan narx saqlanadi)
 *   applyToActive = true  — faol bronlar ham qayta hisoblanadi: to'lov
 *     kutilayotgan, tasdiqlangan va xonadagi mehmonlar. Chiqib ketgan va
 *     bekor qilingan bronlar TARIX — ularga tegilmaydi (o'tgan oy
 *     hisoboti o'zgarib ketmasin).
 */

import { Prisma, type ReservationStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { BASE_CURRENCY, CURRENCY, round2 } from "../lib/money.js";
import { getMealPrice, setSetting, SETTING_KEYS } from "./settings.js";
import { notifyReservation } from "../realtime/notify.js";

/** Narx qayta hisoblanadigan statuslar — hali yakunlanmagan bronlar */
const OPEN_STATUSES: ReservationStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"];

/**
 * Qaysi bronlar "faol bronlarga ham qo'llash" ostiga tushadi.
 *
 * Faqat PMS'da tug'ilgan so'm bronlari: Beds24'dan kelgan bronning
 * narxi OTA'da kelishilgan (nonushta tarif ichida, mapping belgisi) —
 * unga so'm nonushta qo'shilsa summa ikki marta oshardi.
 */
const activeMealWhere = {
  withMeal: true,
  status: { in: OPEN_STATUSES },
  origin: "PMS",
  currency: BASE_CURRENCY,
} satisfies Prisma.ReservationWhereInput;

export type MealPriceInfo = {
  /** Kishi boshiga, so'm */
  price: number;
  currency: typeof CURRENCY;
  /** 0 — belgilanmagan: panel ogohlantiradi */
  isSet: boolean;
  /** "Faol bronlarga ham qo'llash" tanlansa nechta bron qayta hisoblanadi */
  activeBookings: number;
  /** Ulardan nechtasining narxi joriy narxdan farq qiladi */
  activeWithDifferentPrice: number;
};

export async function getMealPriceInfo(): Promise<MealPriceInfo> {
  const price = round2(await getMealPrice());
  const [activeBookings, same] = await Promise.all([
    prisma.reservation.count({ where: activeMealWhere }),
    prisma.reservation.count({
      where: { ...activeMealWhere, mealPricePerPerson: new Prisma.Decimal(price) },
    }),
  ]);
  return {
    price,
    currency: CURRENCY,
    isSet: price > 0,
    activeBookings,
    activeWithDifferentPrice: activeBookings - same,
  };
}

export type SetMealPriceResult = {
  price: number;
  previous: number;
  /** Qayta hisoblangan faol bronlar */
  updatedBookings: number;
};

export async function setMealPrice(
  price: number,
  opts: { applyToActive: boolean; userId?: string }
): Promise<SetMealPriceResult> {
  const next = round2(price);
  const previous = round2(await getMealPrice());

  await setSetting(SETTING_KEYS.mealPrice, String(next), opts.userId);

  if (!opts.applyToActive) {
    return { price: next, previous, updatedBookings: 0 };
  }

  // Faqat narxi haqiqatan farq qiladigan bronlar — keraksiz "o'zgardi"
  // xabari va WebSocket shovqini bo'lmasin
  const targets = await prisma.reservation.findMany({
    where: {
      ...activeMealWhere,
      OR: [
        { mealPricePerPerson: null },
        { mealPricePerPerson: { not: new Prisma.Decimal(next) } },
      ],
    },
    select: { id: true },
  });

  if (targets.length > 0) {
    await prisma.reservation.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { mealPricePerPerson: new Prisma.Decimal(next) },
    });

    // Shaxmatka va boshqa ochiq oynalar yangi summani darhol ko'rsin
    for (const t of targets) {
      await notifyReservation("reservation.updated", t.id);
    }
  }

  return { price: next, previous, updatedBookings: targets.length };
}
