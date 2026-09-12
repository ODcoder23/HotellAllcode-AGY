/**
 * Bron biznes-mantiqi
 *
 * Manba:
 *   07-AVAILABILITY-VA-RATES-SYNC.md §5 — overbooking himoyasi (3 qatlam)
 *   08-RESERVATION-STATUS-VA-TOLOV.md   — statuslar, to'lov
 *   12-PMS-DAN-BEDS24-GA-SYNC.md §1     — TZ 2-band 8 amal
 *
 * MUHIM (TZ 17, 19-band): hech bir amal Beds24 javobini kutmaydi.
 * DB transaction muvaffaqiyatli bo'lsa — amal bajarilgan hisoblanadi.
 * Beds24 tomoni navbat orqali, keyinroq (FAZA 7+ da ulanadi).
 */

import { Prisma, type ReservationStatus, type ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NotFoundError, RoomUnavailableError, ValidationError } from "../lib/errors.js";
import { fromDateKey } from "../lib/serialize.js";
import { serializableTx } from "../lib/tx.js";
import { onAvailabilityChanged } from "./availability.js";
import {
  notifyReservation, notifyPayment, notifyRoomStatus,
} from "../realtime/notify.js";

/** Bron o'qishda har doim shu bog'liqliklar kerak (serializeReservation uchun) */
export const reservationInclude = {
  guest: true,
  charges: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ReservationInclude;

/** Faol bron statuslari — availability hisobida qatnashadi */
const ACTIVE_STATUSES: ReservationStatus[] = [
  "PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT",
];

/**
 * Xona holatini bronga qarab aniqlaydi.
 * Frontenddagi roomStatusForReservation() bilan aynan bir xil
 * (08-fayl §1, Q5 bilan kengaytirilgan).
 */
export function roomStatusFor(status: ReservationStatus) {
  switch (status) {
    case "CHECKED_IN":      return "OCCUPIED" as const;
    case "CHECKED_OUT":     return "DIRTY" as const;
    case "CONFIRMED":       return "RESERVED" as const;
    case "PENDING_PAYMENT": return "RESERVED" as const;  // to'lanmagan ham band
    case "NO_SHOW":         return "AVAILABLE" as const;  // xona bo'shaydi
    case "CANCELLED":       return "AVAILABLE" as const;
  }
}

/**
 * Xona bo'shmi — sana oralig'i kesishuvini tekshiradi.
 * Shaxmatkadagi isRoomAvailable() bilan bir xil: ci < rco && co > rci
 */
export async function isRoomFree(
  roomId: string,
  checkIn: Date,
  checkOut: Date,
  excludeId?: string,
  tx: Prisma.TransactionClient = prisma
): Promise<boolean> {
  const conflict = await tx.reservation.findFirst({
    where: {
      roomId,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return conflict === null;
}

/**
 * Xona holatini qayta hisoblaydi — bron o'zgargandan keyin chaqiriladi.
 *
 * `Room.status` — xonaning JORIY jismoniy holati, sanaga bog'liq emas.
 * Shuning uchun kelajakdagi bronlar unga ta'sir qilmaydi: 111-xonaga
 * keyingi oyga bron qilinsa, xona bugun baribir bo'sh.
 *
 * Ustuvorlik (yuqoridan pastga):
 *   1. CHECKED_IN  bron bugun faol  → OCCUPIED
 *   2. CHECKED_OUT bron bugun tugadi → DIRTY (tozalash kerak)
 *   3. CONFIRMED / PENDING_PAYMENT bugun boshlanadi → RESERVED
 *   4. Aks holda → AVAILABLE
 *
 * OUT_OF_ORDER / OUT_OF_SERVICE qo'lda qo'yiladi va bu funksiya
 * ularga tegmaydi — ta'mirdagi xona bron sababli "bo'sh" bo'lib
 * qolmasligi kerak.
 */
/** Xona holatini qo'lda o'rnatadi va event yuboradi */
export async function setRoomStatus(roomId: string, status: string) {
  const room = await prisma.room.update({
    where: { id: roomId },
    data: { status: status.toUpperCase() as never },
  });
  await notifyRoomStatus(roomId);
  return room;
}

export async function recalcRoomStatus(
  roomId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  const room = await tx.room.findUnique({ where: { id: roomId } });
  if (!room) return;

  // Qo'lda qo'yilgan holatlarga tegilmaydi
  if (room.status === "OUT_OF_ORDER" || room.status === "OUT_OF_SERVICE") return;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Bugun xonada turgan mehmon
  const occupied = await tx.reservation.findFirst({
    where: {
      roomId,
      status: "CHECKED_IN",
      checkIn: { lte: today },
      checkOut: { gt: today },
    },
  });
  if (occupied) {
    await tx.room.update({ where: { id: roomId }, data: { status: "OCCUPIED" } });
    return;
  }

  // Bugun chiqib ketgan — tozalash kerak
  const justLeft = await tx.reservation.findFirst({
    where: { roomId, status: "CHECKED_OUT", checkOut: { gte: today } },
  });
  if (justLeft) {
    await tx.room.update({ where: { id: roomId }, data: { status: "DIRTY" } });
    return;
  }

  // Bugun kutilayotgan mehmon (hali kelmagan)
  const reserved = await tx.reservation.findFirst({
    where: {
      roomId,
      status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
      checkIn: { lte: today },
      checkOut: { gt: today },
    },
  });

  await tx.room.update({
    where: { id: roomId },
    data: { status: reserved ? "RESERVED" : "AVAILABLE" },
  });
}


// ============================================================
//  TZ 2-band — sakkiz amal
// ============================================================

type CreateInput = {
  roomId: string;
  guestName: string;
  phone?: string;
  email?: string;
  checkIn: string;          // "YYYY-MM-DD"
  checkOut: string;
  adults?: number;
  children?: number;
  source?: string;          // "direct" | "booking_com" | ...
  pricePerNight: number;
  notes?: string;
  withMeal?: boolean;
  status?: string;
  initialPayment?: number;
  paymentMethod?: string;
};

/** 1. Yangi bron (TZ 2-band) */
export async function createReservation(input: CreateInput) {
  const checkIn = fromDateKey(input.checkIn);
  const checkOut = fromDateKey(input.checkOut);

  if (checkOut <= checkIn) {
    throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak.");
  }

  const result = await serializableTx(async (tx) => {
    const room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new NotFoundError(`Xona ${input.roomId}`);

    // 2-qatlam himoya (07 §5): tushunarli xato berish uchun.
    // 1-qatlam — DB constraint, u baribir ishlaydi.
    if (!(await isRoomFree(input.roomId, checkIn, checkOut, undefined, tx))) {
      throw new RoomUnavailableError();
    }

    // Mehmon: telefon bo'yicha qidiriladi, topilmasa yaratiladi
    const guest = input.phone
      ? (await tx.guest.findFirst({ where: { phone: input.phone } })) ??
        (await tx.guest.create({
          data: { fullName: input.guestName, phone: input.phone, email: input.email },
        }))
      : await tx.guest.create({
          data: { fullName: input.guestName, email: input.email },
        });

    const status = (input.status?.toUpperCase() ?? "CONFIRMED") as ReservationStatus;

    const reservation = await tx.reservation.create({
      data: {
        roomId: input.roomId,
        guestId: guest.id,
        checkIn,
        checkOut,
        adults: input.adults ?? 1,
        children: input.children ?? 0,
        source: (input.source?.toUpperCase() ?? "DIRECT") as ReservationSource,
        pricePerNight: new Prisma.Decimal(input.pricePerNight),
        notes: input.notes,
        withMeal: input.withMeal ?? false,
        status,
        syncStatus: "PENDING",
        ...(input.initialPayment && input.initialPayment > 0
          ? {
              payments: {
                create: {
                  amount: new Prisma.Decimal(input.initialPayment),
                  method: input.paymentMethod ?? "Naqd",
                  paymentDate: new Date(),
                  note: "Boshlang'ich to'lov",
                },
              },
            }
          : {}),
      },
      include: reservationInclude,
    });

    await recalcRoomStatus(input.roomId, tx);
    return { reservation, roomTypeId: room.roomTypeId };
  }, "createReservation");

  // Hisoblash + event + Beds24 navbati (07-fayl §3, FAZA 9)
  await onAvailabilityChanged([result.roomTypeId], checkIn, checkOut, "reservation_created");

  // TZ 15-band: boshqa ochiq Shaxmatka oynalari ham ko'radi
  await notifyReservation("reservation.created", result.reservation.id);

  return result.reservation;
}

/** 2. Bronni o'zgartirish — mehmon soni, narx, izoh (TZ 2-band) */
export async function updateReservation(
  id: string,
  patch: Partial<Pick<CreateInput, "adults" | "children" | "pricePerNight" | "notes" | "withMeal" | "guestName" | "phone">>
) {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.reservation.findUnique({ where: { id }, include: { guest: true } });
    if (!existing) throw new NotFoundError("Bron");

    if (patch.guestName || patch.phone) {
      await tx.guest.update({
        where: { id: existing.guestId },
        data: {
          ...(patch.guestName ? { fullName: patch.guestName } : {}),
          ...(patch.phone ? { phone: patch.phone } : {}),
        },
      });
    }

    return tx.reservation.update({
      where: { id },
      data: {
        ...(patch.adults !== undefined ? { adults: patch.adults } : {}),
        ...(patch.children !== undefined ? { children: patch.children } : {}),
        ...(patch.pricePerNight !== undefined
          ? { pricePerNight: new Prisma.Decimal(patch.pricePerNight) } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.withMeal !== undefined ? { withMeal: patch.withMeal } : {}),
        syncStatus: "PENDING",
      },
      include: reservationInclude,
    });
  });

  await notifyReservation("reservation.updated", result.id);
  return result;
}

/** 3. Xonani almashtirish (TZ 2-band, mijoz qarori Q6) */
export async function changeRoom(id: string, newRoomId: string) {
  const r = await serializableTx(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    const newRoom = await tx.room.findUnique({ where: { id: newRoomId } });
    if (!newRoom) throw new NotFoundError(`Xona ${newRoomId}`);

    if (!(await isRoomFree(newRoomId, res.checkIn, res.checkOut, id, tx))) {
      throw new RoomUnavailableError("Bu xona endi ushbu sanalar uchun mavjud emas.");
    }

    const oldRoomId = res.roomId;
    const oldTypeId = res.room.roomTypeId;

    const updated = await tx.reservation.update({
      where: { id },
      data: { roomId: newRoomId, syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(oldRoomId, tx);
    await recalcRoomStatus(newRoomId, tx);

    // 12-fayl §4: tur o'zgarsa IKKALA tur ham qayta hisoblanadi
    const types = oldTypeId === newRoom.roomTypeId
      ? [oldTypeId]
      : [oldTypeId, newRoom.roomTypeId];

    return { updated, types, from: res.checkIn, to: res.checkOut };
  }, "changeRoom");

  // Xona almashdi — tur o'zgargan bo'lsa IKKALA tur (12-fayl §4)
  await onAvailabilityChanged(r.types, r.from, r.to, "room_changed");
  await notifyReservation("reservation.updated", r.updated.id);
  return r.updated;
}

/** 4. Sanani o'zgartirish (TZ 2-band) */
export async function changeDates(id: string, checkInKey: string, checkOutKey: string) {
  const checkIn = fromDateKey(checkInKey);
  const checkOut = fromDateKey(checkOutKey);

  if (checkOut <= checkIn) {
    throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak.");
  }

  const r = await serializableTx(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    if (!(await isRoomFree(res.roomId, checkIn, checkOut, id, tx))) {
      throw new RoomUnavailableError("Yangi sanalar uchun xona to'qnashuvi.");
    }

    const updated = await tx.reservation.update({
      where: { id },
      data: { checkIn, checkOut, syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);

    // 12-fayl §5: eski ∪ yangi oraliq
    const from = res.checkIn < checkIn ? res.checkIn : checkIn;
    const to = res.checkOut > checkOut ? res.checkOut : checkOut;

    return { updated, roomTypeId: res.room.roomTypeId, from, to };
  }, "changeDates");

  // Sana o'zgardi — eski ∪ yangi oraliq (12-fayl §5)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "dates_changed");
  await notifyReservation("reservation.updated", r.updated.id);
  return r.updated;
}

/** 5. Check-in (TZ 2-band, mijoz qarori Q7) */
export async function checkIn(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id } });
    if (!res) throw new NotFoundError("Bron");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CHECKED_IN", checkedInAt: new Date(), syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return updated;
  });

  await notifyReservation("reservation.updated", r.id);
  await notifyRoomStatus(r.roomId);
  return r;
}

/** 6. Check-out (TZ 2-band, mijoz qarori Q7) */
export async function checkOut(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CHECKED_OUT", checkedOutAt: new Date(), syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // Erta check-out — qolgan kunlar bo'shaydi (07-fayl §3)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "checked_out");
  await notifyReservation("reservation.updated", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);
  return r.updated;
}

/** 7. Bekor qilish (TZ 2-band) */
export async function cancelReservation(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // Bekor qilindi — kunlar bo'shaydi, Beds24'da availability oshadi
  // (TZ 6-band)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "reservation_cancelled");
  await notifyReservation("reservation.cancelled", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);
  return r.updated;
}

/** No-show (08-fayl §4 — faqat qo'lda, avtomatik emas) */
export async function markNoShow(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "NO_SHOW", syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // No-show — xona bo'shaydi (TZ 6-band)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "no_show");
  await notifyReservation("reservation.cancelled", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);
  return r.updated;
}

// --- To'lov va xarajat (TZ 14-band) -------------------------

export async function addPayment(
  reservationId: string,
  amount: number,
  method: string,
  note?: string
) {
  const res = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!res) throw new NotFoundError("Bron");

  await prisma.payment.create({
    data: {
      reservationId,
      amount: new Prisma.Decimal(amount),
      method,
      paymentDate: new Date(),
      note,
    },
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  await notifyPayment(reservationId);
  return updated;
}

/** To'lovni qaytarish — manfiy summa sifatida (frontend mantiqi bilan bir xil) */
export async function reversePayment(reservationId: string, paymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundError("To'lov");

  const amount = Number(payment.amount.toString());
  await prisma.payment.create({
    data: {
      reservationId,
      amount: new Prisma.Decimal(-amount),
      method: payment.method,
      paymentDate: new Date(),
      note: `Reversal of $${Math.round(amount)} (${payment.method})`,
    },
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  await notifyPayment(reservationId);
  return updated;
}

export async function addCharge(reservationId: string, label: string, amount: number) {
  const res = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!res) throw new NotFoundError("Bron");

  await prisma.charge.create({
    data: { reservationId, label, amount: new Prisma.Decimal(amount) },
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  // Xarajat total'ni o'zgartiradi -> PayPill yangilanishi kerak
  await notifyPayment(reservationId);
  return updated;
}

// --- O'qish -------------------------------------------------

export async function listReservations(from?: string, to?: string) {
  const where: Prisma.ReservationWhereInput = {};
  if (from && to) {
    where.checkIn = { lt: fromDateKey(to) };
    where.checkOut = { gt: fromDateKey(from) };
  }
  return prisma.reservation.findMany({
    where,
    include: reservationInclude,
    orderBy: { checkIn: "asc" },
  });
}

export async function getReservation(id: string) {
  const res = await prisma.reservation.findUnique({ where: { id }, include: reservationInclude });
  if (!res) throw new NotFoundError("Bron");
  return res;
}

export { ACTIVE_STATUSES };
