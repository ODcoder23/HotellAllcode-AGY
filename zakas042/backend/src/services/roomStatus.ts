/**
 * Xona holati — `Room.status` qayta hisoblanadi (YAGONA JOY).
 *
 * Bron amallari (services/reservations.ts) va tozalash tasdig'i
 * (services/cleaning.ts) shu funksiyani chaqiradi — qoida ikki joyda
 * yozilib, bir-biridan uzoqlashmasin.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { hotelToday } from "../lib/hotelTime.js";

/**
 * Xona holatini qayta hisoblaydi — bron o'zgargandan keyin chaqiriladi.
 *
 * `Room.status` — xonaning JORIY jismoniy holati, sanaga bog'liq emas.
 * Shuning uchun kelajakdagi bronlar unga ta'sir qilmaydi: 111-xonaga
 * keyingi oyga bron qilinsa, xona bugun baribir bo'sh.
 *
 * Ustuvorlik (yuqoridan pastga):
 *   1. CHECKED_IN bron bor → OCCUPIED. Sana qaralmaydi: chiqish kuni
 *      soat 10:00 da mehmon hali xonada — "Chiqish" bosilmaguncha band.
 *   2. Xona OCCUPIED edi, endi hech kim yo'q (chiqdi, ko'chirildi) → DIRTY
 *   3. DIRTY → DIRTY. Iflos xonani FAQAT tozalash tasdig'i
 *      (`services/cleaning.ts` `approveTask`) yoki menejer qo'lda ochadi.
 *   4. Bugun boshlanadigan CONFIRMED / PENDING_PAYMENT → RESERVED
 *   5. Aks holda → AVAILABLE
 *
 * 2026-09-26 TUZATISH: ilgari "bugun chiqib ketgan bron bor → DIRTY"
 * qoidasi bor edi. Farrosh tozalab, admin tasdiqlagandan keyin shu
 * xonaga yangi bron qilinsa, qayta hisoblash xonani yana DIRTY qilib
 * qo'yardi va qabulxona mehmonni kiritolmasdi. Teskarisi ham bor edi:
 * kecha chiqib ketgan, tozalanmagan xona bugungi har qanday bron bilan
 * AVAILABLE bo'lib ketardi. Endi DIRTY faqat tozalash bilan yechiladi.
 *
 * OUT_OF_ORDER / OUT_OF_SERVICE qo'lda qo'yiladi va bu funksiya
 * ularga tegmaydi — ta'mirdagi xona bron sababli "bo'sh" bo'lib
 * qolmasligi kerak.
 */
export async function recalcRoomStatus(
  roomId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<boolean> {
  const room = await tx.room.findUnique({ where: { id: roomId } });
  if (!room) return false;

  // Qo'lda qo'yilgan holatlarga tegilmaydi
  if (room.status === "OUT_OF_ORDER" || room.status === "OUT_OF_SERVICE") return false;

  const today = hotelToday();

  // Xonada turgan mehmon — chiqish belgilanmaguncha
  const occupied = await tx.reservation.findFirst({
    where: { roomId, status: "CHECKED_IN" },
    select: { id: true },
  });

  let next: "OCCUPIED" | "DIRTY" | "RESERVED" | "AVAILABLE";
  if (occupied) {
    next = "OCCUPIED";
  } else if (room.status === "OCCUPIED" || room.status === "DIRTY") {
    // Mehmon chiqdi (yoki boshqa xonaga ko'chdi) — tozalash kerak
    next = "DIRTY";
  } else {
    const reserved = await tx.reservation.findFirst({
      where: {
        roomId,
        status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
        checkIn: { lte: today },
        checkOut: { gt: today },
      },
      select: { id: true },
    });
    next = reserved ? "RESERVED" : "AVAILABLE";
  }

  if (next !== room.status) {
    await tx.room.update({ where: { id: roomId }, data: { status: next } });
    return true;
  }
  return false;
}

/**
 * Hamma xonaning holatini qayta hisoblaydi — kun almashganda.
 *
 * NEGA KERAK: RESERVED / AVAILABLE "bugun"ga bog'liq, lekin
 * `recalcRoomStatus` faqat bron amalida chaqirilardi. 2026-09-26 gacha
 * kun almashganda hech narsa qayta hisoblamasdi:
 *   - ertaga keladigan mehmonning xonasi kelish kuni ham "Bo'sh" turardi;
 *   - kelmay qolgan (no-show belgilanmagan) bron xonasi chiqish sanasidan
 *     keyin ham "Band qilingan" bo'lib qolardi.
 * Jadval (queues/scheduler.ts) har soat chaqiradi — server yarim tunda
 * o'chiq bo'lsa ham keyingi soatda o'zini tiklaydi.
 *
 * Har xona o'z tranzaksiyasida: bittasi yiqilsa qolganlari hisoblanadi.
 */
export async function recalcAllRoomStatuses(): Promise<{ changed: string[] }> {
  const rooms = await prisma.room.findMany({
    where: { isActive: true, status: { notIn: ["OUT_OF_ORDER", "OUT_OF_SERVICE"] } },
    select: { id: true },
  });
  const changed: string[] = [];
  for (const r of rooms) {
    const did = await prisma.$transaction((tx) => recalcRoomStatus(r.id, tx));
    if (did) changed.push(r.id);
  }
  return { changed };
}
