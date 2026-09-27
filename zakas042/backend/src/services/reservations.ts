/**
 * Bron biznes-mantiqi
 *
 * Manba:
 *   07-AVAILABILITY-VA-RATES-SYNC.md §5 — overbooking himoyasi (3 qatlam)
 *   08-RESERVATION-STATUS-VA-TOLOV.md   — statuslar, to'lov
 *
 * Har amal bitta DB tranzaksiyasi: muvaffaqiyatli bo'lsa — bajarilgan.
 * Keyin availability keshi yangilanadi va ochiq oynalarga WebSocket
 * xabari ketadi. Tashqi tizim kutilmaydi (Beds24 2026-09-26 da olib
 * tashlangan).
 */

import { Prisma, type ReservationStatus, type ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NotFoundError, RoomUnavailableError, ValidationError } from "../lib/errors.js";
import { fromDateKey, toDateKey, serializeReservation } from "../lib/serialize.js";
import { serializableTx } from "../lib/tx.js";
import { hotelToday } from "../lib/hotelTime.js";
import { onAvailabilityChanged } from "./availability.js";
import { recalcRoomStatus } from "./roomStatus.js";
import {
  formatMoney, mealTotalFor, nightsBetween, roomTotalFor, round2, stayPriceFromRates, toCents,
} from "../lib/money.js";
import { assertSalesOpen } from "./salesStop.js";
import {
  notifyReservation, notifyPayment, notifyRoomStatus,
} from "../realtime/notify.js";
import {
  getMealPrice, getFreeCancelHours, getCancelFeeNights,
} from "./settings.js";
import { createOnCheckout, createStayEndTask } from "./cleaning.js";

/** Bron o'qishda har doim shu bog'liqliklar kerak (serializeReservation uchun) */
export const reservationInclude = {
  guest: true,
  charges: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ReservationInclude;

/**
 * Xonani, sanani o'zgartirish mumkin bo'lgan statuslar.
 *
 * Chiqib ketgan, bekor qilingan va kelmagan bron — tarix: uni boshqa
 * xonaga yoki sanaga ko'chirish hisobot va tozalash tarixini buzadi.
 */
const MOVABLE_STATUSES: ReservationStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"];

/**
 * Status o'tishlari (SAVOLLAR.md S3).
 *
 * NEGA KERAK: ilgari hech qanday qoida yo'q edi — bekor qilingan
 * bronni check-in qilish, chiqib ketgan mehmonni yana kiritish
 * mumkin edi. Overbooking constraint bazani himoya qilardi, lekin
 * status ketma-ketligi ma'nosiz bo'lib qolardi.
 *
 * CHEGARA: bo'sh ro'yxat = yakuniy holat, undan chiqib bo'lmaydi.
 */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED", "NO_SHOW"],
  CONFIRMED:       ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN:      ["CHECKED_OUT"],
  CHECKED_OUT:     [],
  CANCELLED:       [],
  NO_SHOW:         [],
};

/** Statusning o'zbekcha nomi — xato xabarlari uchun */
const STATUS_LABEL: Record<ReservationStatus, string> = {
  PENDING_PAYMENT: "to'lov kutilmoqda",
  CONFIRMED:       "tasdiqlangan",
  CHECKED_IN:      "mehmon kirgan",
  CHECKED_OUT:     "mehmon chiqqan",
  CANCELLED:       "bekor qilingan",
  NO_SHOW:         "kelmadi",
};

/**
 * O'tish mumkinmi — mumkin bo'lmasa tushunarli xato tashlaydi.
 *
 * Bir xil statusga o'tish (CHECKED_IN -> CHECKED_IN) ham rad
 * etiladi: bu odatda ikki marta bosilgan tugma, va checkedInAt
 * vaqtini buzadi.
 */
function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (ALLOWED_TRANSITIONS[from].includes(to)) return;

  throw new ValidationError(
    `Bron "${STATUS_LABEL[from]}" holatida — uni "${STATUS_LABEL[to]}" ` +
    `qilib bo'lmaydi`
  );
}

/** Xona/sana o'zgartirish faqat faol bronda */
function assertMovable(status: ReservationStatus): void {
  if (MOVABLE_STATUSES.includes(status)) return;
  throw new ValidationError(
    `Bron "${STATUS_LABEL[status]}" holatida — xona yoki sanani o'zgartirib bo'lmaydi`
  );
}

/**
 * Xona bo'shmi — IKKI shartni tekshiradi:
 *
 *   1. Sana oralig'i boshqa bron bilan kesishmasligi
 *      (Shaxmatkadagi `isRoomAvailable()` bilan bir xil:
 *       `ci < rco && co > rci`)
 *
 *   2. Oraliqdagi birorta kun ta'mir/xizmatdan chiqarilgan
 *      bo'lmasligi (`RoomDayStatus.isBlocked`)
 *
 * IKKINCHI SHART 2026-09-16 DA QO'SHILDI. Undan oldin yopiq
 * xonaga bron tushaverardi: admin Shaxmatkada ta'mirdagi xonani
 * tanlay olardi. Mehmon kelganda xona yopiq bo'lib chiqardi.
 *
 * YAGONA JOY: bu funksiya bron yaratish, xona almashtirish, sana
 * o'zgartirish va bo'sh xona qidirishda chaqiriladi. Tekshiruv shu
 * yerda bo'lgani uchun hammasi bir vaqtda himoyalanadi.
 *
 * Yopilgan kunlar oralig'i: bron `[checkIn, checkOut)` — chiqish
 * kuni xona bo'sh, shuning uchun u tekshirilmaydi.
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
  if (conflict !== null) return false;

  const blocked = await tx.roomDayStatus.findFirst({
    where: {
      roomId,
      isBlocked: true,
      date: { gte: checkIn, lt: checkOut },
    },
    select: { id: true },
  });
  return blocked === null;
}

// ============================================================
//  TZ 2-band — bron amallari
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
  priceReason?: string;
  notes?: string;
  withMeal?: boolean;
  status?: string;
  initialPayment?: number;
  paymentMethod?: string;
  /** To'lovni kim qabul qilgani (S13) — initialPayment uchun */
  userId?: string;
};

/**
 * Tarif bo'yicha yashash narxi — oraliqdagi RatePlan'lar (SAVOLLAR.md S4).
 *
 * 2026-09-25: ilgari faqat KIRISH kunining tarifi olinardi. Juma 130,
 * shanba 100 bo'lsa sayt o'rtacha 115 dan sotardi va bu "tarifdan past"
 * deb sayt bronini rad etardi. Endi butun oraliq jami solishtiriladi
 * (`lib/money.ts` `stayPriceFromRates`, sayt ham shu formulada).
 *
 * Tarif topilmasa null: yangi xona turi yoki narx hali
 * kiritilmagan bo'lishi mumkin, bu bronni to'sish uchun sabab emas.
 */
async function tariffStayTotal(
  roomTypeId: string,
  checkIn: Date,
  checkOut: Date,
  tx: Prisma.TransactionClient = prisma
): Promise<number | null> {
  const plans = await tx.ratePlan.findMany({
    where: { roomTypeId, date: { gte: checkIn, lt: checkOut } },
    select: { price: true },
  });
  return stayPriceFromRates(plans.map((p) => p.price), nightsBetween(checkIn, checkOut))?.roomTotal ?? null;
}

/**
 * Narx tarifga mosmi (SAVOLLAR.md S4).
 *
 * QOIDA: chegirma mumkin, lekin sababsiz emas. Tarifdan past narx
 * `priceReason` talab qiladi — hisobotda "nega arzon sotilgan"
 * ko'rinib tursin. Tarifdan yuqori narx erkin: bayram kuni yoki
 * kelishuv narxi bo'lishi mumkin, u daromadni kamaytirmaydi.
 *
 * NEGA qat'iy taqiq emas: qabulxona kelishuv narxi bilan ishlaydi,
 * har chegirma uchun menejer chaqirish ishni to'xtatib qo'yardi.
 */
function assertPriceOk(
  price: number,
  nights: number,
  tariffTotal: number | null,
  reason: string | null | undefined
): void {
  // Jami summalar tiyinda solishtiriladi
  const total = roomTotalFor(price, nights);
  if (tariffTotal === null || toCents(total) >= toCents(tariffTotal)) return;
  if (reason && reason.trim().length >= 3) return;

  throw new ValidationError(
    `Narx tarifdan past (${nights} kecha: tarif ${formatMoney(tariffTotal)}, ` +
    `kiritilgan ${formatMoney(total)}) — chegirma sababini yozing`
  );
}

/**
 * Mehmonni topadi yoki yaratadi (SAVOLLAR.md S6, S7).
 *
 * TELEFON BOR: shu telefonli mehmon qidiriladi. Topilsa, ism
 * FARQ QILSA yangilanadi — ilgari eski ism qolib ketardi va
 * bron boshqa odam nomiga yozilgandek ko'rinardi.
 *
 * TELEFON YO'Q: har safar yangi yozuv. Bu ataylab — telefonsiz
 * ikki "Anonim mehmon" ni bir odam deb hisoblash xato bo'lardi.
 * Shuning uchun telefon majburiy (route validatsiyasi).
 */
async function findOrCreateGuest(
  input: Pick<CreateInput, "guestName" | "phone" | "email">,
  tx: Prisma.TransactionClient
) {
  if (!input.phone) {
    return tx.guest.create({
      data: { fullName: input.guestName, email: input.email },
    });
  }

  const existing = await tx.guest.findFirst({ where: { phone: input.phone } });

  if (!existing) {
    return tx.guest.create({
      data: { fullName: input.guestName, phone: input.phone, email: input.email },
    });
  }

  // Ism yoki email o'zgargan bo'lsa yangilaymiz (S6)
  const changed =
    existing.fullName !== input.guestName ||
    (input.email !== undefined && existing.email !== input.email);

  if (!changed) return existing;

  return tx.guest.update({
    where: { id: existing.id },
    data: {
      fullName: input.guestName,
      ...(input.email ? { email: input.email } : {}),
    },
  });
}

/** 1. Yangi bron (TZ 2-band) */
export async function createReservation(input: CreateInput) {
  const checkIn = fromDateKey(input.checkIn);
  const checkOut = fromDateKey(input.checkOut);

  if (checkOut <= checkIn) {
    throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak.");
  }

  // STOP (Sozlamalar -> Tizim nazorati): to'xtatilgan xonaga yangi bron
  // yo'q. Kunlar ham yopiq, lekin xabar aniq bo'lsin ("xona band" emas)
  await assertSalesOpen(input.roomId, (input.source ?? "").toUpperCase() === "WEBSITE" ? "guest" : "staff");

  // Transaction ichida emas: mavjudlik tekshiruvi tashqarida
  // bajarilsa transaction qulfini ushlab turmaydi
  const payerId = await resolveUserId(input.userId);

  /**
   * Nonushta narxi bron yaratilganda KO'CHIRILADI (S10).
   *
   * NEGA: narx keyin ko'tarilsa, eski bronlarning summasi
   * o'zgarib ketardi — mehmon kelishilgandan ko'p to'lardi.
   */
  const mealPrice = input.withMeal ? await getMealPrice() : 0;

  const result = await serializableTx(async (tx) => {
    const room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new NotFoundError(`Xona ${input.roomId}`);
    if (!room.isActive) throw new ValidationError(`Xona ${input.roomId} inventardan chiqarilgan`);

    // 2-qatlam himoya (07 §5): tushunarli xato berish uchun.
    // 1-qatlam — DB constraint, u baribir ishlaydi.
    if (!(await isRoomFree(input.roomId, checkIn, checkOut, undefined, tx))) {
      throw new RoomUnavailableError();
    }

    // Narx tarifdan past bo'lsa sabab talab qilinadi (S4)
    assertPriceOk(
      input.pricePerNight,
      nightsBetween(checkIn, checkOut),
      await tariffStayTotal(room.roomTypeId, checkIn, checkOut, tx),
      input.priceReason
    );

    // Boshlang'ich to'lov bron summasidan oshmasin (S1).
    // Bu yerda alohida tekshiriladi, chunki bron hali yaratilmagan
    // va currentBalance() uni topa olmaydi.
    // Formula — lib/money.ts (bron summasi bilan bir xil)
    if (input.initialPayment && input.initialPayment > 0) {
      const nights = nightsBetween(checkIn, checkOut);
      const guests = (input.adults ?? 1) + (input.children ?? 0);
      const totalC = toCents(roomTotalFor(input.pricePerNight, nights))
        + toCents(mealTotalFor(mealPrice, guests, nights));
      if (toCents(input.initialPayment) > totalC) {
        throw new ValidationError(
          `Boshlang'ich to'lov bron summasidan ko'p: ` +
          `bron ${formatMoney(totalC / 100)}, to'lov ${formatMoney(input.initialPayment)}`
        );
      }
    }

    const guest = await findOrCreateGuest(input, tx);

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
        // 4 xona: sayt narxi tariflar yig'indisi / kechalar (lib/money.ts)
        pricePerNight: new Prisma.Decimal(input.pricePerNight.toFixed(4)),
        priceReason: input.priceReason?.trim() || null,
        notes: input.notes,
        withMeal: input.withMeal ?? false,
        mealPricePerPerson: mealPrice > 0 ? new Prisma.Decimal(mealPrice) : null,
        status,
        ...(input.initialPayment && input.initialPayment > 0
          ? {
              payments: {
                create: {
                  amount: new Prisma.Decimal(round2(input.initialPayment)),
                  method: input.paymentMethod ?? "Naqd",
                  paymentDate: hotelToday(),
                  note: "Boshlang'ich to'lov",
                  userId: payerId,
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

  // Kesh + event (07-fayl §3)
  await onAvailabilityChanged([result.roomTypeId], checkIn, checkOut, "reservation_created");

  // TZ 15-band: boshqa ochiq Shaxmatka oynalari ham ko'radi
  await notifyReservation("reservation.created", result.reservation.id);
  await notifyRoomStatus(result.reservation.roomId);

  return result.reservation;
}

type UpdatePatch = Partial<Pick<
  CreateInput,
  "adults" | "children" | "pricePerNight" | "priceReason" | "notes" | "withMeal" | "guestName" | "phone"
>>;

/** 2. Bronni o'zgartirish — mehmon soni, narx, izoh (TZ 2-band) */
export async function updateReservation(id: string, patch: UpdatePatch) {
  /**
   * Nonushta keyin yoqilsa narx shu paytdagi sozlamadan ko'chiriladi.
   *
   * 2026-09-25 TUZATISH: ilgari `withMeal: true` qilinganda
   * `mealPricePerPerson` bo'sh qolardi — oshxona mehmonni sanardi,
   * lekin bron summasiga nonushta qo'shilmasdi (bepul ovqat).
   */
  const mealPriceNow = patch.withMeal === true ? await getMealPrice() : null;

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!existing) throw new NotFoundError("Bron");

    // Faqat haqiqatan o'zgarsa: tahrir formasi izoh yoki ovqatni
    // o'zgartirganda ham narxni qaytaradi (4 xona bilan solishtiriladi)
    const priceChanged = patch.pricePerNight !== undefined
      && Math.round(patch.pricePerNight * 10_000) !== Math.round(Number(existing.pricePerNight) * 10_000);

    /**
     * Tarifdan past narx — sabab bilan (S4), yaratishdagi qoida bilan bir xil.
     *
     * 2026-09-26 TUZATISH: tahrirda tekshiruv yo'q edi — bronni tarif
     * narxida yaratib, keyin narxni sababsiz 1 so'mga tushirish mumkin
     * edi. `priceReason` route'da qabul qilinardi, lekin yozilmasdi.
     */
    if (priceChanged) {
      assertPriceOk(
        patch.pricePerNight!,
        nightsBetween(existing.checkIn, existing.checkOut),
        await tariffStayTotal(existing.room.roomTypeId, existing.checkIn, existing.checkOut, tx),
        patch.priceReason ?? existing.priceReason
      );
    }

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
        // Faqat o'zgarganda yoziladi: saqlangan 4 xonali narx buzilmasin
        ...(priceChanged
          ? { pricePerNight: new Prisma.Decimal(patch.pricePerNight!.toFixed(4)) } : {}),
        ...(patch.priceReason !== undefined ? { priceReason: patch.priceReason.trim() || null } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.withMeal !== undefined ? { withMeal: patch.withMeal } : {}),
        // Nonushta narxi ilgari ko'chirilmagan bo'lsa — hozirgisi
        ...(mealPriceNow !== null && mealPriceNow > 0 && existing.mealPricePerPerson === null
          ? { mealPricePerPerson: new Prisma.Decimal(round2(mealPriceNow)) } : {}),
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
    assertMovable(res.status);

    const newRoom = await tx.room.findUnique({ where: { id: newRoomId } });
    if (!newRoom) throw new NotFoundError(`Xona ${newRoomId}`);
    if (!newRoom.isActive) throw new ValidationError(`Xona ${newRoomId} inventardan chiqarilgan`);
    if (newRoomId === res.roomId) throw new ValidationError("Bron allaqachon shu xonada");

    // Xonadagi mehmonni ta'mirdagi yoki iflos xonaga ko'chirib bo'lmaydi
    if (res.status === "CHECKED_IN" && newRoom.status !== "AVAILABLE" && newRoom.status !== "RESERVED") {
      throw new ValidationError(`Xona ${newRoomId} hozir mehmon qabul qila olmaydi (${newRoom.status.toLowerCase()})`);
    }

    if (!(await isRoomFree(newRoomId, res.checkIn, res.checkOut, id, tx))) {
      throw new RoomUnavailableError("Bu xona endi ushbu sanalar uchun mavjud emas.");
    }

    const oldRoomId = res.roomId;
    const oldTypeId = res.room.roomTypeId;

    const updated = await tx.reservation.update({
      where: { id },
      data: { roomId: newRoomId },
      include: reservationInclude,
    });

    await recalcRoomStatus(oldRoomId, tx);
    await recalcRoomStatus(newRoomId, tx);

    // 12-fayl §4: tur o'zgarsa IKKALA tur ham qayta hisoblanadi
    const types = oldTypeId === newRoom.roomTypeId
      ? [oldTypeId]
      : [oldTypeId, newRoom.roomTypeId];

    return { updated, types, from: res.checkIn, to: res.checkOut, oldRoomId };
  }, "changeRoom");

  await onAvailabilityChanged(r.types, r.from, r.to, "room_changed");
  await notifyReservation("reservation.updated", r.updated.id);
  await notifyRoomStatus(r.oldRoomId);
  await notifyRoomStatus(r.updated.roomId);
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
    assertMovable(res.status);

    // Xonadagi mehmonning kirish sanasi — o'tgan fakt, uni o'zgartirib
    // bo'lmaydi; faqat chiqish sanasi (uzaytirish / qisqartirish)
    if (res.status === "CHECKED_IN" && checkIn.getTime() !== res.checkIn.getTime()) {
      throw new ValidationError("Mehmon allaqachon kirgan — faqat chiqish sanasini o'zgartirish mumkin");
    }

    if (!(await isRoomFree(res.roomId, checkIn, checkOut, id, tx))) {
      throw new RoomUnavailableError("Yangi sanalar uchun xona to'qnashuvi.");
    }

    const updated = await tx.reservation.update({
      where: { id },
      data: { checkIn, checkOut },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);

    // 12-fayl §5: eski ∪ yangi oraliq
    const from = res.checkIn < checkIn ? res.checkIn : checkIn;
    const to = res.checkOut > checkOut ? res.checkOut : checkOut;

    return { updated, roomTypeId: res.room.roomTypeId, from, to };
  }, "changeDates");

  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "dates_changed");
  await notifyReservation("reservation.updated", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);
  return r.updated;
}

/**
 * Bronni tasdiqlash: PENDING_PAYMENT -> CONFIRMED (13-fayl §5).
 *
 * Website'dan kelgan bron to'lov kutilayotgan holatda yaratiladi.
 * Admin to'lovni qabul qilgach shu amal chaqiriladi.
 *
 * NEGA ALOHIDA AMAL, `updateReservation` ichida emas: status
 * o'zgarishi biznes hodisasi — xona holatini qayta hisoblaydi va
 * avtomatik bekor qilishdan chiqaradi. Uni oddiy maydon tahriri bilan
 * aralashtirish xatoga olib keladi.
 */
export async function confirmReservation(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id } });
    if (!res) throw new NotFoundError("Bron");

    assertTransition(res.status, "CONFIRMED");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CONFIRMED" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return updated;
  });

  await notifyReservation("reservation.updated", r.id);
  await notifyRoomStatus(r.roomId);
  return r;
}

/** 5. Check-in (TZ 2-band, mijoz qarori Q7) */
export async function checkIn(id: string) {
  const today = hotelToday();

  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({
      where: { id },
      include: { room: true },
    });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "CHECKED_IN");

    /**
     * Kirish faqat bron kunlarida (2026-09-26).
     *
     * Ilgari kelasi oyga bronni bugun "kirdi" qilish mumkin edi: xona
     * holati, oshxona hisobi va dashboard "xonada" deb sanardi, lekin
     * xona aslida bo'sh edi. Mehmon erta kelsa — avval sana o'zgartiriladi
     * (qo'shimcha kecha narxi bilan).
     */
    if (res.checkIn > today) {
      throw new ValidationError(
        `Bron ${toDateKey(res.checkIn)} dan boshlanadi — erta kelgan bo'lsa avval sanani o'zgartiring`
      );
    }
    if (res.checkOut <= today) {
      throw new ValidationError(
        `Bron muddati ${toDateKey(res.checkOut)} da tugagan — "Kelmadi" deb belgilang yoki sanani o'zgartiring`
      );
    }

    /**
     * Tozalanmagan xonaga mehmon kiritilmaydi (SAVOLLAR.md S12).
     *
     * NEGA check-in da, bron yaratishda emas: bron kelajakka
     * qilinadi va xona o'shangacha tozalanadi. Faqat mehmon
     * eshik oldida turganda xona haqiqatan tayyor bo'lishi kerak.
     *
     * Farrosh xonani tozalab, panelda "tayyor" belgilaydi ->
     * status AVAILABLE bo'ladi -> check-in ochiladi.
     */
    if (res.room.status === "DIRTY") {
      throw new ValidationError(
        `Xona ${res.roomId} hali tozalanmagan — tozalangandan keyin ` +
        `mehmonni kiriting`
      );
    }

    if (res.room.status === "OUT_OF_ORDER" || res.room.status === "OUT_OF_SERVICE") {
      throw new ValidationError(
        `Xona ${res.roomId} ishlatishdan chiqarilgan — boshqa xona tanlang`
      );
    }

    // Oldingi mehmon hali chiqish qilmagan (chiqish kuni kechikkan) —
    // bitta xonada ikki "kirgan" mehmon bo'lmasin
    const stillInside = await tx.reservation.findFirst({
      where: { roomId: res.roomId, status: "CHECKED_IN", id: { not: id } },
      include: { guest: { select: { fullName: true } } },
    });
    if (stillInside) {
      throw new ValidationError(
        `Xona ${res.roomId} da hali oldingi mehmon (${stillInside.guest.fullName}) — avval uni chiqaring`
      );
    }

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CHECKED_IN", checkedInAt: new Date() },
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
    assertTransition(res.status, "CHECKED_OUT");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CHECKED_OUT", checkedOutAt: new Date() },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // Erta check-out — qolgan kunlar bo'shaydi (07-fayl §3)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "checked_out");

  /**
   * Tozalash topshirig'i (TOZALIK-BOT.md §2A).
   *
   * Xona DIRTY bo'ldi — navbatdagi faroshga xabar ketadi.
   * Xato tashlamaydi: topshiriq yaratilmagani uchun check-out
   * bekor qilinmasligi kerak.
   */
  await createOnCheckout(r.updated.roomId);
  await notifyReservation("reservation.updated", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);
  return r.updated;
}

/**
 * Bekor qilish jarimasi (SAVOLLAR.md S11).
 *
 * QOIDA: kirish sanasiga `freeCancelHours` dan kam qolgan bo'lsa
 * `cancelFeeNights` kecha narxi olinadi. Egasi qarori Q16 (2026-09-26):
 * jarima YO'Q — standart 0 kecha, bekor qilish doim bepul. Sozlama
 * orqali qayta yoqilishi mumkin.
 *
 * NEGA JARIMA DAROMAD: xona band turgan va boshqa mehmonga
 * sotilmagan. Hisobotda "bekor qilingan = 0 daromad" ko'rsatish
 * haqiqatni buzardi.
 */
async function cancellationFeeFor(res: {
  checkIn: Date;
  pricePerNight: Prisma.Decimal;
}): Promise<number> {
  const [freeHours, feeNights] = await Promise.all([
    getFreeCancelHours(),
    getCancelFeeNights(),
  ]);

  if (!(feeNights > 0)) return 0;

  const hoursLeft = (res.checkIn.getTime() - Date.now()) / 3_600_000;
  if (hoursLeft >= freeHours) return 0;

  // Kasr kecha (0.5) ham mumkin — summa tiyingacha
  return roomTotalFor(res.pricePerNight, feeNights);
}

/** 7. Bekor qilish (TZ 2-band) */
export async function cancelReservation(id: string) {
  // Jarima transaction'dan TASHQARIDA hisoblanadi: sozlamalarni
  // o'qish qulfni ushlab turmasin
  const before = await prisma.reservation.findUnique({
    where: { id },
    select: { checkIn: true, pricePerNight: true },
  });
  if (!before) throw new NotFoundError("Bron");

  const fee = await cancellationFeeFor(before);

  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "CANCELLED");

    const updated = await tx.reservation.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        ...(fee > 0 ? { cancellationFee: new Prisma.Decimal(fee) } : {}),
      },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // Bekor qilindi — kunlar bo'shaydi (TZ 6-band)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "reservation_cancelled");

  // Muddatidan oldin (yashash boshlangan) bekor qilindi — xona tozalansin
  // (egasi talabi, 2026-09-26). Kelajakdagi bron bekor qilinsa xona
  // ishlatilmagan — xabar kerak emas
  if (r.from <= hotelToday()) {
    await createStayEndTask(r.updated.roomId, "Bron muddatidan oldin bekor qilindi (admin)");
  }
  await notifyReservation("reservation.cancelled", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);
  return r.updated;
}

/**
 * Bekor qilishdan OLDIN jarimani ko'rsatadi.
 *
 * Frontend buni bekor qilish tugmasi bosilganda chaqiradi va
 * xodimga "1 kecha narxi olinadi, davom etasizmi?" deb so'raydi.
 * Jarima kutilmaganda paydo bo'lmasin.
 */
export async function previewCancellation(id: string): Promise<{
  fee: number;
  freeUntilHours: number;
  isFree: boolean;
}> {
  const res = await prisma.reservation.findUnique({
    where: { id },
    select: { checkIn: true, pricePerNight: true },
  });
  if (!res) throw new NotFoundError("Bron");

  const [fee, freeHours] = await Promise.all([
    cancellationFeeFor(res),
    getFreeCancelHours(),
  ]);

  return { fee, freeUntilHours: freeHours, isFree: fee === 0 };
}

/** No-show (08-fayl §4 — faqat qo'lda, avtomatik emas) */
export async function markNoShow(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "NO_SHOW");

    // Kelmadi — kirish kuni kelgandan keyin ma'lum bo'ladi. Kelajakdagi
    // bron uchun bu bekor qilish (u hisobotda boshqacha sanaladi)
    if (res.checkIn > hotelToday()) {
      throw new ValidationError(
        `Bron ${toDateKey(res.checkIn)} dan boshlanadi — kelajakdagi bronni "Bekor qilish" kerak`
      );
    }

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "NO_SHOW" },
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

/**
 * Bronning hozirgi qarzi (SAVOLLAR.md S1).
 *
 * Formula `serializeReservation()` dan olinadi — YAGONA MANBA.
 *
 * NEGA: ilgari formula ikki joyda yozilgan edi. Nonushta
 * qo'shilganda biri yangilanib, ikkinchisi eski qolsa, xodim
 * to'liq to'lay olmay qolardi ("qarz 0" deydi, lekin to'lovni
 * rad etadi) — sababini hech kim topa olmasdi.
 */
async function currentBalance(
  reservationId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<{ total: number; paid: number; due: number }> {
  const res = await tx.reservation.findUnique({
    where: { id: reservationId },
    include: reservationInclude,
  });
  if (!res) throw new NotFoundError("Bron");

  const view = serializeReservation(res);

  return {
    total: view.totalPrice,
    paid: view.paidAmount,
    // Tiyinda ayiriladi: float qoldig'i (0.30000000004) to'lovni rad etmasin
    due: (toCents(view.totalPrice) - toCents(view.paidAmount)) / 100,
  };
}

/**
 * Haqiqatan mavjud foydalanuvchi ID'sini qaytaradi, aks holda null.
 *
 * NEGA KERAK: dev rejimida `authMiddleware` soxta `id: "dev"`
 * beradi (AUTH_REQUIRED=false), bunday User yo'q va to'lov yozish
 * foreign key xatosi bilan yiqilardi.
 *
 * To'lovni yozish — asosiy amal, "kim qabul qildi" esa qo'shimcha
 * ma'lumot. Noma'lum xodim tufayli mehmonning puli yozilmay
 * qolishi mumkin emas.
 */
async function resolveUserId(userId?: string): Promise<string | null> {
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * Bir bron bo'yicha pul amallari ketma-ket bajarilsin.
 *
 * 2026-09-26 TUZATISH: to'lov chegarasi (qarzdan oshmasin) balansni
 * o'qib, keyin yozardi. Ikki kassir bir vaqtda to'liq summani
 * kiritsa, ikkalasi ham "qarz bor" ni ko'rib, bron ikki marta
 * to'langan bo'lib qolardi. Endi bron qatori `FOR UPDATE` bilan
 * qulflanadi — ikkinchi so'rov birinchisi tugashini kutadi va yangi
 * balansni ko'radi.
 */
async function lockReservation(tx: Prisma.TransactionClient, reservationId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Reservation" WHERE id = ${reservationId} FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundError("Bron");
}

/**
 * To'lov qo'shish.
 *
 * IKKI CHEGARA (SAVOLLAR.md S1, S2):
 *   1. Musbat to'lov qarzdan oshmasin — kassada ortiqcha pul
 *      ko'rinib, hisobot daromadi haqiqatdan katta bo'lib qolardi
 *   2. Manfiy to'lov (qaytarish) to'langandan oshmasin — aks holda
 *      balans manfiyga tushib, mehmonxona mehmondan qarzdor
 *      bo'lib qolardi
 */
export async function addPayment(
  reservationId: string,
  amount: number,
  method: string,
  note?: string,
  userId?: string
) {
  // Tiyingacha: 12.345 kabi qiymat bazada yarim tiyin bo'lib qolmasin
  amount = round2(amount);
  if (amount === 0) {
    throw new ValidationError("To'lov summasi noldan farqli bo'lishi kerak");
  }

  const payerId = await resolveUserId(userId);

  await prisma.$transaction(async (tx) => {
    await lockReservation(tx, reservationId);
    const { paid, due } = await currentBalance(reservationId, tx);

    // Solishtirish tiyinda — float qoldig'i to'liq to'lovni rad etmasin
    if (amount > 0 && toCents(amount) > toCents(due)) {
      throw new ValidationError(
        due <= 0
          ? "Bron to'liq to'langan — qo'shimcha to'lov qabul qilinmaydi"
          : `To'lov qarzdan oshib ketdi: qarz ${formatMoney(due)}, kiritilgan ${formatMoney(amount)}`
      );
    }

    if (amount < 0 && toCents(-amount) > toCents(paid)) {
      throw new ValidationError(
        `Qaytarish summasi to'langandan ko'p: to'langan ${formatMoney(paid)}, ` +
        `qaytarilmoqchi ${formatMoney(-amount)}`
      );
    }

    await tx.payment.create({
      data: {
        reservationId,
        amount: new Prisma.Decimal(amount),
        method,
        paymentDate: hotelToday(),
        note,
        userId: payerId,
      },
    });
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  await notifyPayment(reservationId);
  return updated;
}

/**
 * To'lovni qaytarish — manfiy summa sifatida yoziladi.
 *
 * Asl to'lov o'chirilmaydi: audit uchun "qabul qilindi, keyin
 * qaytarildi" ikkalasi ham ko'rinib tursin.
 */
export async function reversePayment(
  reservationId: string,
  paymentId: string,
  userId?: string
) {
  const payerId = await resolveUserId(userId);

  await prisma.$transaction(async (tx) => {
    await lockReservation(tx, reservationId);

    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError("To'lov");

    if (payment.reservationId !== reservationId) {
      throw new ValidationError("To'lov bu bronga tegishli emas");
    }

    const amount = Number(payment.amount.toString());
    if (amount < 0) {
      throw new ValidationError("Qaytarilgan to'lovni yana qaytarib bo'lmaydi");
    }

    // Balansni manfiyga tushirmaslik (S2): bir to'lov ikki marta
    // qaytarilsa yoki qo'lda manfiy to'lov kiritilgan bo'lsa to'sadi
    const { paid } = await currentBalance(reservationId, tx);
    if (toCents(amount) > toCents(paid)) {
      throw new ValidationError(
        `Bu to'lov allaqachon qaytarilgan (to'langan qoldiq ${formatMoney(paid)})`
      );
    }

    await tx.payment.create({
      data: {
        reservationId,
        amount: new Prisma.Decimal(-amount),
        method: payment.method,
        paymentDate: hotelToday(),
        note: `Qaytarildi: ${formatMoney(amount)} (${payment.method})`,
        userId: payerId,
      },
    });
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  await notifyPayment(reservationId);
  return updated;
}

/**
 * Qo'shimcha xizmat (kir yuvish, minibar, transfer).
 *
 * Musbat bo'lishi shart: chegirma xarajat orqali emas, narxni
 * o'zgartirish orqali beriladi (SAVOLLAR.md S4).
 */
export async function addCharge(reservationId: string, label: string, amount: number) {
  const res = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!res) throw new NotFoundError("Bron");

  if (amount <= 0) {
    throw new ValidationError("Xizmat summasi musbat bo'lishi kerak");
  }

  // Bekor qilingan bron summasi = faqat jarima (lib/money.ts) — xizmat
  // qo'shilsa ham hisobga kirmaydi, xodim esa uni "qarz" deb kutardi
  if (res.status === "CANCELLED" || res.status === "NO_SHOW") {
    throw new ValidationError(`Bron "${STATUS_LABEL[res.status]}" holatida — xizmat qo'shib bo'lmaydi`);
  }

  await prisma.charge.create({
    data: { reservationId, label, amount: new Prisma.Decimal(round2(amount)) },
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
