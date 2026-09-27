/**
 * Beds24 broni -> PMS Reservation — TZ 1, 4, 9-band
 *
 * Webhook worker'i ham, polling ham shu fayldagi `applyReservation` dan
 * o'tadi — bitta yo'l: dedup, xona biriktirish, to'lov, echo himoyasi
 * ikkalasida bir xil ishlaydi.
 *
 *   a. externalReservationId bo'yicha mavjud bron qidiriladi
 *   b. Topilmasa — qo'lda kiritilgan shu OTA broni qidiriladi (bog'lanadi)
 *   c. Hech biri yo'q — mapping orqali xona tanlanadi, yangi bron
 *   d. Topilsa — mavjud bron yangilanadi (Beds24 ustuvor, Q9)
 *   e. Availability qayta hisoblanadi, Shaxmatka darhol ko'radi
 *
 * MIJOZ QARORI Q3: xona AVTOMATIK biriktiriladi, admin aralashmaydi.
 */

import { Prisma, type ReservationStatus, type ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { fromDateKey, toDateKey } from "../lib/serialize.js";
import { hotelToday } from "../lib/hotelTime.js";
import { isBaseCurrency, nightsBetween, perNight } from "../lib/money.js";
import { logPull } from "../lib/syncLog.js";
import { rateFor } from "./exchangeRate.js";
import { getChannel } from "./channel/registry.js";
import { findByExternal } from "./mapping.js";
import { isRoomFree } from "./reservations.js";
import { recalcRoomStatus } from "./roomStatus.js";
import { toPmsStatus, classifyExternal, mergeIncomingStatus } from "./beds24/statusMap.js";
import { onAvailabilityChanged } from "./availability.js";
import type { ExternalReservation } from "./channel/types.js";
import {
  notifyReservation, notifyPayment, notifyRoomStatus, notifyWebhookNeedsAttention, notifySyncFailed,
} from "../realtime/notify.js";
import { createOnCheckout, createStayEndTask } from "./cleaning.js";
import { applyChannelBlock, findChannelBlock } from "./channelBlocks.js";

export { toPmsStatus };

export type ProcessResult = {
  status: "processed" | "skipped" | "needs_manual_action" | "failed";
  reservationId?: string;
  detail: string;
  /**
   * Nega qo'lda hal qilish kerak. `no_mapping` — sozlama (xona
   * bog'lanmagan), jim; `no_free_room` / `conflict` — overbooking
   * xavfi, egasiga Telegram xabari ham ketadi
   */
  problem?: "no_mapping" | "no_free_room" | "conflict";
  /** Yangi bron yaratildimi (true) yoki mavjudi yangilandi/bog'landi (false) */
  created?: boolean;
};

/** OTA manbalari — qo'lda kiritilgan OTA bronini topish uchun */
const OTA_ENUM: ReservationSource[] = ["BOOKING_COM", "AIRBNB", "EXPEDIA", "OSTROVOK", "OTHER"];

// ============================================================
//  Manba
// ============================================================

/**
 * OTA nomini `ReservationSource` enum'iga aylantiradi.
 *
 * Natija egalikni ham belgilaydi (`lib/channelOwnership.ts`): Beds24'dan
 * kelgan `DIRECT` — PMS boshqaradi, qolgani (`OTHER` ham) — OTA'niki.
 */
export function toSource(source?: string, channelCode?: string): ReservationSource {
  // Kanal kodi ishonchliroq: `referer` erkin matn ("Agent_200"),
  // `channel` esa Beds24'ning o'z kodi ("booking", "direct")
  const c = (channelCode ?? "").toLowerCase();
  if (c === "booking") return "BOOKING_COM";
  if (c === "airbnb") return "AIRBNB";
  if (c === "expedia") return "EXPEDIA";
  // ETG (Emerging Travel Group) — Ostrovok/ZenHotels
  if (c.startsWith("ostrovok") || c === "etg" || c === "emergingtravel") return "OSTROVOK";
  if (c === "direct") return "DIRECT";
  if (c) return "OTHER";

  const r = (source ?? "").toLowerCase();
  if (r.includes("booking")) return "BOOKING_COM";
  if (r.includes("airbnb")) return "AIRBNB";
  if (r.includes("expedia")) return "EXPEDIA";
  if (r.includes("ostrovok") || r.includes("etg")) return "OSTROVOK";
  if (r.includes("pms") || r === "direct") return "DIRECT";
  return "OTHER";
}

/**
 * Kelgan bron PMS'dagi holat bilan bir xilmi — haqiqiy aks-sado.
 * Birortasi farq qilsa bu Beds24 tomonidagi o'zgarish — qo'llanadi (Q9).
 */
async function matchesPms(
  known: { checkIn: Date; checkOut: Date; adults: number; children: number; status: ReservationStatus; room: { roomTypeId: string } },
  ext: ExternalReservation
): Promise<boolean> {
  if (toDateKey(known.checkIn) !== ext.checkIn || toDateKey(known.checkOut) !== ext.checkOut) return false;
  if (known.adults !== ext.adults || known.children !== ext.children) return false;
  if (mergeIncomingStatus(known.status, toPmsStatus(ext)).status !== known.status) return false;

  const target = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
  const targetType = target?.roomTypeId ?? target?.room?.roomTypeId;
  return targetType === known.room.roomTypeId;
}

/** OTA raqami izohga — xodim Booking.com'dagi bronni topa olsin */
function withReference(ext: ExternalReservation, notes?: string | null): string | undefined {
  const ref = ext.externalReference ? `[${ext.source ?? "OTA"} #${ext.externalReference}]` : "";
  const body = notes ?? ext.notes ?? "";
  if (!ref || body.includes(ref)) return body || undefined;
  return [ref, body].filter(Boolean).join("\n");
}

/** Beds24 tarifi nonushtali (mapping'da belgilangan) — oshxona sanaydi */
async function channelBookingHasMeal(channelId: string, externalRoomTypeId: string): Promise<boolean> {
  const mapping = await prisma.channelMapping.findFirst({
    where: { channelId, externalRoomTypeId, isActive: true, includesMeal: true },
    select: { id: true },
  });
  return mapping !== null;
}

// ============================================================
//  Avtomatik xona biriktirish (Q3)
// ============================================================

export type AssignResult =
  | {
      ok: true;
      roomId: string;
      roomTypeId: string;
      /** Beds24 xonasiga mos PMS xonasi band edi — mehmon boshqa xonaga joylandi */
      relocatedFrom?: string;
    }
  | { ok: false; reason: "no_mapping" | "no_free_room"; detail: string };

/**
 * Kelgan bron uchun xona tanlaydi.
 *
 * QAT'IY QOIDA: mapping topilmasa bron YARATILMAYDI — taxminiy mapping
 * aslo ishlatilmaydi.
 *
 * Bo'sh xona topilmasa — Beds24 bizda bo'lmagan xonani sotgan degani.
 * Bron yaratilmaydi, admin qo'lda hal qiladi (NEEDS_MANUAL_ACTION):
 * OTA'da tasdiqlangan real mehmon — uni boshqa xonaga joylash kerak.
 *
 * Aniq xona (Room 1 = 101) band bo'lsa mehmon shu turdagi bo'sh xonaga
 * joylanadi — Shaxmatkadan yo'qolmasin. Avval Beds24'ga BOG'LANMAGAN
 * xona olinadi: Beds24'da bron eski xonada qoladi va u xona (PMS'da
 * band) sotilmaydi. Bog'langan xona — faqat boshqasi bo'lmasa, chunki
 * Beds24 uni bo'sh deb sotishi mumkin (chaqiruvchi xodimni ogohlantiradi).
 */
export async function assignRoom(ext: ExternalReservation, excludeReservationId?: string): Promise<AssignResult> {
  const mapping = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
  if (!mapping) {
    return {
      ok: false,
      reason: "no_mapping",
      detail:
        `Beds24 xona turi ${ext.externalRoomTypeId}${ext.externalUnitId ? `/unit ${ext.externalUnitId}` : ""} ` +
        `PMS'ga bog'lanmagan. Channel manager -> Xonalarni bog'lash, keyin "Qayta ishlash".`,
    };
  }

  const checkIn = fromDateKey(ext.checkIn);
  const checkOut = fromDateKey(ext.checkOut);

  // 1) Unit darajasi — aniq xona
  if (mapping.roomId && (await isRoomFree(mapping.roomId, checkIn, checkOut, excludeReservationId))) {
    const room = await prisma.room.findUniqueOrThrow({ where: { id: mapping.roomId } });
    return { ok: true, roomId: room.id, roomTypeId: room.roomTypeId };
  }

  const roomTypeId = mapping.roomTypeId ?? mapping.room?.roomTypeId;
  if (!roomTypeId) return { ok: false, reason: "no_mapping", detail: "Mapping'da xona turi ko'rsatilmagan" };

  // 2) Tur bo'yicha birinchi bo'sh xona (ta'mirdagilar emas)
  const candidates = await prisma.room.findMany({
    where: { roomTypeId, isActive: true, status: { notIn: ["OUT_OF_ORDER", "OUT_OF_SERVICE"] } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  const relocatedFrom = mapping.roomId ?? undefined;
  if (relocatedFrom) {
    const unitMapped = new Set(
      (await prisma.channelMapping.findMany({
        where: { channelId: mapping.channelId, isActive: true, roomId: { not: null } },
        select: { roomId: true },
      })).map((m) => m.roomId)
    );
    candidates.sort((a, b) => Number(unitMapped.has(a.id)) - Number(unitMapped.has(b.id)));
  }
  for (const room of candidates) {
    if (await isRoomFree(room.id, checkIn, checkOut, excludeReservationId)) {
      return { ok: true, roomId: room.id, roomTypeId, ...(relocatedFrom ? { relocatedFrom } : {}) };
    }
  }

  return {
    ok: false,
    reason: "no_free_room",
    detail:
      `${roomTypeId} turida ${ext.checkIn}..${ext.checkOut} uchun bo'sh xona yo'q — ` +
      `Beds24 PMS'da band xonani sotgan. Mehmonni qo'lda joylashtiring.`,
  };
}

/**
 * Qo'lda kiritilgan shu OTA broni PMS'da bormi (2026-09-27).
 *
 * Beds24 olib tashlangan davrda (va ulanishdan oldin) qabulxona
 * Booking.com bronlarini qo'lda kiritgan. Import ularni TAKRORLAMASIN —
 * topilsa Beds24 broniga bog'lanadi (keyingi o'zgarishlar shu bronga
 * yoziladi). Qidiruv:
 *   1. OTA raqami (`externalReference` = Beds24 `apiReference`) — aniq
 *   2. Bir xil sanalar, shu tarif (yoki shu xona), shu OTA manbasi va
 *      hali bog'lanmagan — FAQAT bitta nomzod bo'lsa
 */
async function findManualOtaEntry(ext: ExternalReservation) {
  const baseWhere = {
    externalReservationId: null,
    code: null,
    status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] as ReservationStatus[] },
  } satisfies Prisma.ReservationWhereInput;

  if (ext.externalReference) {
    const byRef = await prisma.reservation.findFirst({
      where: { ...baseWhere, externalReference: ext.externalReference },
      include: { room: true },
    });
    if (byRef) return byRef;
  }

  const source = toSource(ext.source, ext.channelCode);
  if (!OTA_ENUM.includes(source)) return null;

  const target = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
  const roomTypeId = target?.roomTypeId ?? target?.room?.roomTypeId;
  if (!roomTypeId) return null;

  const candidates = await prisma.reservation.findMany({
    where: {
      ...baseWhere,
      source,
      checkIn: fromDateKey(ext.checkIn),
      checkOut: fromDateKey(ext.checkOut),
      room: { roomTypeId },
    },
    include: { room: true },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// ============================================================
//  Asosiy ishlov
// ============================================================

export async function processWebhookEvent(webhookEventId: string): Promise<ProcessResult> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event) return { status: "failed", detail: "WebhookEvent topilmadi" };

  if (event.status === "PROCESSED" || event.status === "IGNORED_DUPLICATE") {
    return { status: "skipped", detail: `Allaqachon ${event.status}` };
  }

  const parsed = getChannel().parseWebhook(event.rawPayload);

  // --- Echo loop himoyasi ---
  // Faqat BIZ bilgan bron (bazada bor) va hech narsa farq qilmasa. Aks
  // holda Beds24 tomonidagi o'zgarish (panelda sana, xona) yo'qolardi,
  // yoki OTA'dan kelgan yangi bron jimgina tashlanardi.
  if (parsed.isOwnEcho && parsed.externalId && parsed.reservation) {
    const known = await prisma.reservation.findFirst({
      where: { externalReservationId: parsed.externalId },
      include: { room: true },
    });
    if (known && (await matchesPms(known, parsed.reservation))) {
      await markProcessed(webhookEventId);
      await logPull("webhook_echo_skipped", "SKIPPED", { reservationId: known.id, response: { detail: "referer=PMS" } });
      return { status: "skipped", detail: "O'z aks-sadosi" };
    }
  }

  if (!parsed.reservation) {
    await markProcessed(webhookEventId);
    return { status: "skipped", detail: "Bron ma'lumoti yo'q" };
  }

  try {
    const result = await applyReservation(parsed.reservation);

    if (result.status === "needs_manual_action") {
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: "NEEDS_MANUAL_ACTION", errorMessage: result.detail.slice(0, 500), processedAt: new Date() },
      });
      await logPull("webhook_needs_action", "FAILED", { reservationId: result.reservationId, errorMessage: result.detail });
      notifyWebhookNeedsAttention(webhookEventId, result.detail, { telegram: result.problem !== "no_mapping" });
      return result;
    }

    await markProcessed(webhookEventId);
    await logPull(`webhook_${parsed.event.replace(/\./g, "_")}`, result.status === "skipped" ? "SKIPPED" : "SUCCESS", {
      reservationId: result.reservationId,
      response: { detail: result.detail },
    });
    return result;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { status: "FAILED", errorMessage: detail.slice(0, 500), attempts: { increment: 1 } },
    });
    await logPull("webhook_failed", "FAILED", { errorMessage: detail });
    throw e;    // BullMQ qayta urinishi uchun
  }
}

/**
 * Kelgan bronni PMS'ga qo'llaydi — yaratish, bog'lash yoki yangilash.
 *
 * TZ 9-band: `@@unique([channelId, externalReservationId])` — hatto
 * mantiq xato qilsa ham ikkinchi bron jismonan yaratilmaydi.
 */
export async function applyReservation(ext: ExternalReservation): Promise<ProcessResult> {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { code: "beds24" } });

  let existing = await prisma.reservation.findFirst({
    where: { channelId: channel.id, externalReservationId: ext.externalId },
    include: { room: true },
  });

  // --- Mehmon broni emas ---
  // `black` — Beds24'da xona yopilgan: ChannelBlock orqali PMS kunlari
  // yopiladi/ochiladi. Yopish bekor qilinganda status `cancelled` keladi —
  // mavjud yopish yozuvi ham shu yo'lga yo'naltiriladi. `inquiry` — so'rov.
  const kind = classifyExternal(ext);
  if (kind === "inquiry") {
    return { status: "skipped", detail: `So'rov (inquiry) #${ext.externalId} — xonani band qilmaydi` };
  }
  if (kind === "block" || (!existing && (await findChannelBlock(ext.externalId)))) {
    const r = await applyChannelBlock(ext);
    return { status: r.status, detail: r.detail };
  }

  // --- Qo'lda kiritilgan shu OTA broni — bog'lanadi, takrorlanmaydi ---
  if (!existing) {
    const manual = await findManualOtaEntry(ext);
    if (manual) {
      await prisma.reservation.update({
        where: { id: manual.id },
        data: {
          channelId: channel.id,
          externalReservationId: ext.externalId,
          origin: "CHANNEL",
          ...(ext.externalReference ? { externalReference: ext.externalReference } : {}),
          syncStatus: "SYNCED",
          syncError: null,
          lastSyncedAt: new Date(),
        },
      });
      existing = await prisma.reservation.findUniqueOrThrow({ where: { id: manual.id }, include: { room: true } });
      await logPull("booking_linked", "SUCCESS", {
        reservationId: manual.id,
        response: { externalId: ext.externalId, externalReference: ext.externalReference ?? null },
      });
    }
  }

  // Webhook valyutani bermaydi — kanal (obyekt) valyutasi. So'rov yiqilsa
  // xato tashlanadi va qayta uriniladi: taxminiy valyuta bilan yozishdan
  // ko'ra kutgan yaxshi
  const currency = (ext.currency || await getChannel().getCurrency()).toUpperCase();

  const incomingStatus = toPmsStatus(ext);
  // OTA jami narxi kechalarga 4 xona aniqlikda bo'linadi: $100 / 3 =
  // 33.3333, bron summasi esa yana aynan $100.00 (lib/money.ts)
  const nights = nightsBetween(fromDateKey(ext.checkIn), fromDateKey(ext.checkOut));
  const pricePerNight = perNight(ext.price > 0 ? ext.price : 0, nights);

  // ===== MAVJUD BRONNI YANGILASH =====
  if (existing) {
    // PMS o'zgarishi hali Beds24'ga yetmagan (xodim xona/sanani
    // o'zgartirdi, navbat yubormoqda yoki Beds24 rad etdi) — polling
    // olib kelgan ESKI Beds24 holati uni qaytarib yozmasin. Faqat bekor
    // qilish (OTA'da) qabul qilinadi: u har doim ustuvor
    const localPending = ["PENDING", "SYNCING", "FAILED", "REJECTED"].includes(existing.syncStatus);
    const cancelling = incomingStatus === "CANCELLED" || incomingStatus === "NO_SHOW";
    if (localPending && !cancelling) {
      return {
        status: "skipped",
        reservationId: existing.id,
        detail: `Bron #${ext.externalId}: PMS o'zgarishi hali Beds24'ga yuborilmagan — Beds24 holati kutiladi`,
      };
    }

    // Beds24 ustuvor (Q9), lekin xonadagi mehmon holati saqlanadi
    const merged = mergeIncomingStatus(existing.status, incomingStatus);
    const status = merged.status;
    const active = status !== "CANCELLED" && status !== "NO_SHOW";

    // Xona: Beds24 qayerda desa o'sha yerda — sana, tur yoki unit
    // o'zgargan bo'lishi mumkin (OTA yoki Beds24 panelida)
    let roomId = existing.roomId;
    if (active) {
      const target = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
      if (!target) {
        return {
          status: "needs_manual_action",
          reservationId: existing.id,
          detail: `Beds24 xona turi ${ext.externalRoomTypeId} PMS'ga bog'lanmagan — Channel manager -> Xonalarni bog'lash.`,
          problem: "no_mapping",
        };
      }
      const targetType = target.roomTypeId ?? target.room?.roomTypeId;
      const placedRight = target.roomId
        ? existing.roomId === target.roomId
        : existing.room.roomTypeId === targetType;
      const free = await isRoomFree(existing.roomId, fromDateKey(ext.checkIn), fromDateKey(ext.checkOut), existing.id);

      if (!placedRight || !free) {
        const assigned = await assignRoom(ext, existing.id);
        if (!assigned.ok) {
          return {
            status: "needs_manual_action",
            reservationId: existing.id,
            detail: `Beds24'da bron o'zgardi, lekin ${assigned.detail}`,
            problem: assigned.reason,
          };
        }
        roomId = assigned.roomId;
      }
    }

    // Valyuta farq qilsa PMS narxi saqlanadi: PMS'da tug'ilgan so'm broni
    // Beds24'ga dollarda boradi, Beds24 esa o'sha dollar narxni qaytaradi —
    // u so'mdagi narx ustiga yozilib ketardi
    const samePriceUnit = currency === existing.currency.toUpperCase();

    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        roomId,
        checkIn: fromDateKey(ext.checkIn),
        checkOut: fromDateKey(ext.checkOut),
        adults: ext.adults,
        children: ext.children,
        // Narxsiz (0) kelgan yangilanish PMS narxini o'chirmasin
        ...(samePriceUnit && ext.price > 0 ? { pricePerNight: new Prisma.Decimal(pricePerNight) } : {}),
        status,
        notes: withReference(ext, ext.notes ?? existing.notes),
        ...(ext.externalReference ? { externalReference: ext.externalReference } : {}),
        checkedInAt: status === "CHECKED_IN" ? (existing.checkedInAt ?? new Date()) : existing.checkedInAt,
        checkedOutAt: status === "CHECKED_OUT" ? (existing.checkedOutAt ?? new Date()) : existing.checkedOutAt,
        cancelledAt: status === "CANCELLED" ? (existing.cancelledAt ?? new Date()) : existing.cancelledAt,
        // Beds24'dan keldi — qayta yuborish kerak emas
        syncStatus: "SYNCED",
        syncError: null,
        lastSyncedAt: new Date(),
      },
    });

    await syncPayments(updated.id, channel.id, ext, currency);
    await prisma.$transaction(async (tx) => {
      await recalcRoomStatus(existing!.roomId, tx);
      if (roomId !== existing!.roomId) await recalcRoomStatus(roomId, tx);
    });

    // Tozalash xabari: Beds24'da "chiqdi" belgisi yoki yashash boshlangan
    // bron bekor qilindi — Shaxmatkadagi bilan bir xil
    const stayStarted = existing.checkIn <= hotelToday();
    if (status === "CHECKED_OUT" && existing.status !== "CHECKED_OUT") {
      await createOnCheckout(existing.roomId);
    } else if (status === "CANCELLED" && existing.status !== "CANCELLED" && stayStarted) {
      await createStayEndTask(existing.roomId, "Bron muddatidan oldin bekor qilindi (Beds24)");
    }

    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    await onAvailabilityChanged(
      [...new Set([existing.room.roomTypeId, room.roomTypeId])],
      fromDateKey(ext.checkIn) < existing.checkIn ? fromDateKey(ext.checkIn) : existing.checkIn,
      fromDateKey(ext.checkOut) > existing.checkOut ? fromDateKey(ext.checkOut) : existing.checkOut,
      "ota_reservation_updated"
    );

    // TZ 4, 15-band: Shaxmatka sahifani yangilamasdan ko'radi
    await notifyReservation(status === "CANCELLED" ? "reservation.cancelled" : "reservation.updated", updated.id);
    await notifyRoomStatus(existing.roomId);
    if (roomId !== existing.roomId) await notifyRoomStatus(roomId);
    if ((ext.payments ?? []).length > 0) await notifyPayment(updated.id);

    // Beds24 bekor qildi, lekin mehmon xonada — yozildi, admin hal qiladi
    if (merged.conflict) {
      return { status: "needs_manual_action", reservationId: updated.id, detail: merged.conflict, problem: "conflict" };
    }
    return { status: "processed", reservationId: updated.id, detail: `Bron yangilandi: ${status}, xona ${roomId}`, created: false };
  }

  // ===== YANGI BRON =====
  const status = incomingStatus;

  // Bekor qilingan bronni yaratish ma'nosiz
  if (status === "CANCELLED" || status === "NO_SHOW") {
    return { status: "skipped", detail: `Yangi bron ${status} holatida keldi — yaratilmadi` };
  }
  // Tugagan (o'tmishdagi) bron — tarix, PMS'ga kerak emas
  if (fromDateKey(ext.checkOut) < hotelToday()) {
    return { status: "skipped", detail: `Bron #${ext.externalId} o'tmishda tugagan — yaratilmadi` };
  }

  const assigned = await assignRoom(ext);
  if (!assigned.ok) return { status: "needs_manual_action", detail: assigned.detail, problem: assigned.reason };

  const guest = await findOrCreateGuest(ext);

  // Ovqat: Beds24 standart maydon bermaydi — mapping'dagi belgi. Belgilanmagan
  // bo'lsa `false`: ortiqcha tayyorlagandan ko'ra so'raganda bergan yaxshi
  const withMeal = await channelBookingHasMeal(channel.id, ext.externalRoomTypeId);

  // Kurs (Q15): Beds24 broni o'z valyutasida (USD) qoladi, tagida so'm —
  // bron KELGAN kundagi Markaziy bank kursi, bronga yoziladi va qotadi.
  // Bank javob bermasa bron baribir yaratiladi, kurs keyin to'ldiriladi
  const exchangeRate = isBaseCurrency(currency) ? null : await rateFor(currency);

  let created;
  try {
    created = await prisma.reservation.create({
      data: {
        roomId: assigned.roomId,
        guestId: guest.id,
        checkIn: fromDateKey(ext.checkIn),
        checkOut: fromDateKey(ext.checkOut),
        adults: ext.adults,
        children: ext.children,
        source: toSource(ext.source, ext.channelCode),
        origin: "CHANNEL",
        externalReference: ext.externalReference ?? null,
        withMeal,
        channelId: channel.id,
        externalReservationId: ext.externalId,
        pricePerNight: new Prisma.Decimal(pricePerNight),
        currency,
        exchangeRate: exchangeRate ? new Prisma.Decimal(exchangeRate) : null,
        notes: withReference(ext),
        status,
        checkedInAt: status === "CHECKED_IN" ? new Date() : null,
        checkedOutAt: status === "CHECKED_OUT" ? new Date() : null,
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
      },
    });
  } catch (e) {
    const raw = `${String(e)} ${e instanceof Error ? e.message : ""}`;
    // TZ 9-band: unique ishga tushdi — poyga, boshqa worker yaratib ulgurgan
    if ((e as { code?: string }).code === "P2002" || raw.includes("externalReservationId")) {
      return applyReservation(ext);
    }
    // Overbooking constraint (23P01) — bo'sh xona tekshiruvi o'tib ketdi
    if (raw.includes("reservation_no_overlap") || raw.includes("23P01")) {
      return {
        status: "needs_manual_action",
        detail: `Xona ${assigned.roomId} band bo'lib qoldi (poyga). Mehmonni qo'lda joylashtiring.`,
        problem: "no_free_room",
      };
    }
    throw e;
  }

  await syncPayments(created.id, channel.id, ext, currency);
  await prisma.$transaction((tx) => recalcRoomStatus(assigned.roomId, tx));

  await onAvailabilityChanged(
    [assigned.roomTypeId],
    fromDateKey(ext.checkIn),
    fromDateKey(ext.checkOut),
    "ota_reservation_created"
  );

  // TZ 4-band: OTA'dan kelgan bron Shaxmatkada DARHOL ko'rinadi (va
  // egasiga Telegram xabari — notifyReservation ichida)
  await notifyReservation("reservation.created", created.id);
  await notifyRoomStatus(assigned.roomId);
  if ((ext.payments ?? []).length > 0) await notifyPayment(created.id);

  // Mehmon Beds24 xonasidan boshqa xonaga joylandi — overbooking xavfi:
  // PMS'dagi band qilgan bron Beds24'ga yetmagan (rad etilgan / kutmoqda)
  if (assigned.relocatedFrom) {
    const detail =
      `Beds24 broni #${ext.externalId} (${ext.guest.fullName}, ${ext.checkIn}..${ext.checkOut}) ` +
      `${assigned.relocatedFrom}-xonaga tushdi, lekin u PMS'da band — mehmon ${assigned.roomId}-xonaga joylandi. ` +
      `${assigned.relocatedFrom}-xonadagi PMS broni Beds24'da yo'q: tekshiring.`;
    await logPull("reservation_relocated", "FAILED", { reservationId: created.id, roomId: assigned.roomId, errorMessage: detail });
    notifySyncFailed("reservation_relocated", detail, created.id, { telegram: true });
  }

  return {
    status: "processed",
    reservationId: created.id,
    detail: `Yangi bron: xona ${assigned.roomId}, ${status}, ${ext.guest.fullName}`,
    created: true,
  };
}

/**
 * Mehmonni topadi yoki yaratadi. Telefon/email — tabiiy kalit, lekin
 * mavjud yozuv TO'LDIRILADI (bo'sh maydonlar), bor ma'lumot o'chirilmaydi.
 */
async function findOrCreateGuest(ext: ExternalReservation) {
  const { fullName, phone, email, country, address } = ext.guest;

  const existing =
    (phone ? await prisma.guest.findFirst({ where: { phone } }) : null) ??
    (email ? await prisma.guest.findFirst({ where: { email } }) : null);

  if (existing) {
    const patch: Record<string, string> = {};
    if (fullName && fullName !== "Noma'lum mehmon" && fullName !== existing.fullName) patch.fullName = fullName;
    if (email && !existing.email) patch.email = email;
    if (phone && !existing.phone) patch.phone = phone;
    if (country && !existing.country) patch.country = country;
    if (address && !existing.address) patch.address = address;
    return Object.keys(patch).length > 0
      ? prisma.guest.update({ where: { id: existing.id }, data: patch })
      : existing;
  }

  return prisma.guest.create({ data: { fullName, phone, email, country, address } });
}

/**
 * Beds24'dan kelgan to'lovlarni PMS'ga yozadi (TZ 14-band).
 *
 * `@@unique([channelId, externalPaymentId])` — bir to'lov ikki marta
 * yozilmaydi. Beds24 invoice item id bermasa — summa+izoh bo'yicha kalit.
 *
 * VALYUTA: to'lov obyekt valyutasida (USD). Dollar bronga — o'zgarishsiz.
 * PMS'da tug'ilgan so'm bronga (Beds24'ga yuborilgan) — bugungi kurs
 * bilan so'mga, asl dollar summasi saqlanadi. Kurs noma'lum bo'lsa
 * to'lov hozir yozilmaydi: keyingi webhook / polling qayta keltiradi.
 */
async function syncPayments(
  reservationId: string,
  channelId: string,
  ext: ExternalReservation,
  channelCurrency: string
): Promise<void> {
  if ((ext.payments ?? []).every((p) => p.amount === 0)) return;

  const res = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { currency: true } });
  const payCurrency = (channelCurrency || res.currency).toUpperCase();
  const convert = payCurrency !== res.currency.toUpperCase();
  const rate = convert ? await rateFor(payCurrency) : 1;
  if (convert && (!rate || !isBaseCurrency(res.currency))) {
    console.warn(
      `[beds24] bron ${reservationId}: to'lov ${payCurrency} da, bron ${res.currency} da — kurs noma'lum, keyingi sinxronda yoziladi`
    );
    return;
  }

  for (const p of ext.payments ?? []) {
    if (p.amount === 0) continue;
    const legacyId = `${ext.externalId}:${p.amount}:${p.description ?? ""}`;
    const externalPaymentId = p.externalId ?? legacyId;

    const already = await prisma.payment.findFirst({
      where: { channelId, externalPaymentId: { in: [externalPaymentId, legacyId] } },
    });
    if (already) continue;

    try {
      await prisma.payment.create({
        data: {
          reservationId,
          amount: new Prisma.Decimal(convert ? Math.round(p.amount * rate! * 100) / 100 : p.amount),
          ...(convert
            ? {
                originalAmount: new Prisma.Decimal(p.amount),
                originalCurrency: payCurrency,
                exchangeRate: new Prisma.Decimal(rate!),
              }
            : {}),
          // OTA to'lovi — kassa hisobotida ajratish uchun
          method: `Onlayn (${ext.source ?? "OTA"})`,
          paymentDate: hotelToday(),
          note: p.description,
          externalPaymentId,
          channelId,
        },
      });
    } catch (e) {
      // Parallel ishlov yozib ulgurgan — takror emas, xato ham emas
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
}

async function markProcessed(id: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: "PROCESSED", processedAt: new Date(), errorMessage: null },
  });
}

/**
 * Navbatga tushmay qolgan (Redis o'chiq edi) event'larni qayta ishlaydi.
 */
export async function processPendingEvents(limit = 50): Promise<{
  processed: number; skipped: number; needsAction: number; failed: number;
}> {
  const staleAfter = new Date(Date.now() - 2 * 60_000);
  const pending = await prisma.webhookEvent.findMany({
    where: { status: "QUEUED", createdAt: { lt: staleAfter } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const counts = { processed: 0, skipped: 0, needsAction: 0, failed: 0 };
  for (const event of pending) {
    try {
      const r = await processWebhookEvent(event.id);
      if (r.status === "processed") counts.processed++;
      else if (r.status === "skipped") counts.skipped++;
      else if (r.status === "needs_manual_action") counts.needsAction++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}
