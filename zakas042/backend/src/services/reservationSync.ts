/**
 * Bron sinxroni — PMS -> Beds24 (TZ 2-band)
 *
 * TZ 2-band: Shaxmatkadagi sakkiz amal (yaratish, o'zgartirish, xona,
 * sana, check-in, check-out, bekor qilish, kelmadi) Beds24 bilan
 * sinxronlanadi. Mijoz qarorlari: Q6 (xona almashsa Beds24'da ham),
 * Q7 (check-in/out — bayroq bilan).
 *
 * IDEMPOTENTLIK: worker job payload'idagi eski nusxaga emas, DB'dagi
 * JORIY holatga qarab ish ko'radi. Job ikki marta bajarilsa ham natija
 * bir xil; navbatda turganda bron yana o'zgarsa — eng oxirgi holat ketadi.
 *
 * ECHO LOOP HIMOYASI — uch qatlam:
 *   1. Beds24 API orqali yozilgan bron uchun webhook YUBORMAYDI
 *      (`actions.allowWebhooks` berilmasa)
 *   2. `referer: "PMS"` — faqat biz YARATGAN bronda
 *   3. webhookProcessor: kelgan ma'lumot PMS holati bilan bir xil
 *      bo'lsa hech narsa yozilmaydi
 *
 * OTA BRONLARI (Q9, "Beds24 ustuvor"): Booking.com va boshqa OTA'dan
 * kelgan bronning narxi, sanasi, mehmoni va statusi OTA'niki — PMS
 * ularni Beds24'da o'zgartirmaydi, faqat xona/unit va check-in/out
 * belgisini yuboradi (`mode: "ota"`).
 *
 * 2026-09-27 (qaytarilganda) tuzatishlar — integratsiya shular sabab
 * 2026-09-26 da olib tashlangan edi:
 *   - Beds24 rad etgan bron (joy yo'q) REJECTED bo'ladi va avtomatik
 *     qayta yuborilmaydi. Ilgari FAILED bo'lib, catch-up har 15 daqiqada
 *     qayta POST qilardi — Beds24 tarixi shu bilan to'lgan
 *   - mapping yo'q bron NOT_APPLICABLE (jim); mapping qo'yilganda
 *     `mapping.ts` `requeueAfterMappingChange` qayta yuboradi
 *   - Beds24 ulanmagan bo'lsa bron PENDING qoladi (xato emas)
 *   - tugagan, bekor qilingan, kelmagan bron Beds24'da YANGI bron
 *     bo'lib yaratilmaydi
 */

import type { ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { toDateKey } from "../lib/serialize.js";
import { hotelToday } from "../lib/hotelTime.js";
import { isBaseCurrency, roomTotalFor, round2, nightsBetween } from "../lib/money.js";
import { logPush } from "../lib/syncLog.js";
import { isChannelOwned } from "../lib/channelOwnership.js";
import { findRoomTypeMapping, findRoomMapping } from "./mapping.js";
import { getChannel } from "./channel/registry.js";
import type { PushMode } from "./channel/types.js";
import { toBeds24Status, otaFlagFor } from "./beds24/statusMap.js";
import { activeConnection } from "./beds24/auth.js";
import { rateFor } from "./exchangeRate.js";
import { notifyReservation, notifySyncFailed } from "../realtime/notify.js";
import { reservationSyncQueue, enqueueWithTimeout, type ReservationSyncJob } from "../queues/index.js";

export type ChangeType = ReservationSyncJob["changeType"];

/** OTA manbalari — ular Beds24'ga OTA'ning o'zidan keladi */
const OTA_SOURCES: ReadonlySet<ReservationSource> = new Set<ReservationSource>([
  "BOOKING_COM", "AIRBNB", "EXPEDIA", "OSTROVOK",
]);

/**
 * Jarayon ichidagi qulf: bir bron uchun bir vaqtda bitta push.
 *
 * Ikki chaqiruv parallel kelsa, ikkinchisi birinchisining natijasini
 * KUTADI va uning `externalReservationId`ini ko'radi — ya'ni create
 * emas, update yuboradi. Aks holda Beds24'da ikkita bron paydo bo'ladi.
 */
const inFlight = new Map<string, Promise<SyncOutcome>>();

export type SyncOutcome =
  | { status: "sent"; externalId?: string; created: boolean }
  | { status: "skipped"; reason: string }
  | { status: "rejected"; error: string }
  | { status: "failed"; error: string; retryable: boolean };

/**
 * Ismni first/last ga ajratadi. Bir so'zli ism bo'lsa familiya
 * bo'sh qolmasligi uchun nuqta — Beds24 bo'sh `lastName`ni rad etadi.
 */
export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "Mehmon", last: "." };
  if (parts.length === 1) return { first: parts[0]!, last: "." };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/** SYNCING band qilishi shundan eski bo'lsa — egasi o'lgan deb hisoblanadi */
const STALE_CLAIM_MS = 2 * 60_000;
/** Navbat oynasi: bir xil amal shu vaqt ichida bitta yuborish bo'ladi */
const RES_SYNC_WINDOW_MS = 2000;

/**
 * Boshqa jarayon bronni yuborib, `externalReservationId` yozishini
 * kutadi. Bo'lmasa `null` — chaqiruvchi job'ni qayta urinishga qoldiradi.
 */
async function waitForExternalId(reservationId: string, timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { externalReservationId: true, syncStatus: true },
    });
    if (r?.externalReservationId) return r.externalReservationId;
    if (r && r.syncStatus !== "SYNCING") return null;
    if (Date.now() >= deadline) return null;
    await new Promise((x) => setTimeout(x, 150));
  }
}

/** Yangilash rejimi — `Reservation.origin` bo'yicha (lib/channelOwnership.ts) */
export function pushModeFor(res: {
  origin: string;
  source: ReservationSource;
  channelId: string | null;
  externalReservationId: string | null;
}): PushMode {
  return isChannelOwned(res) ? "ota" : "full";
}

async function markSync(
  id: string,
  syncStatus: "SYNCED" | "FAILED" | "REJECTED" | "NOT_APPLICABLE" | "PENDING",
  syncError: string | null
): Promise<void> {
  await prisma.reservation.update({
    where: { id },
    data: {
      syncStatus,
      syncError: syncError ? syncError.slice(0, 500) : null,
      ...(syncStatus === "SYNCED" ? { lastSyncedAt: new Date() } : {}),
    },
  });
  // Shaxmatka bron belgisini (✓ / ⚠) darhol yangilasin
  await notifyReservation("reservation.updated", id);
}

// ============================================================
//  1. Bronni Beds24'ga yuborish
// ============================================================

/**
 * Bir bronni Beds24'ga yuboradi — yaratish yoki yangilash.
 *
 * `externalReservationId` bo'lsa update, bo'lmasa create. Ya'ni sakkiz
 * amalning hammasi bitta yo'ldan o'tadi: "shu bron hozir mana bunday".
 */
export function pushReservation(reservationId: string): Promise<SyncOutcome> {
  const running = inFlight.get(reservationId);
  if (running) {
    // Birinchisi tugagach biz ham yuboramiz — natija o'sha paytdagi holatga mos
    return running.then(() => pushReservation(reservationId));
  }
  const task = doPush(reservationId).finally(() => {
    inFlight.delete(reservationId);
  });
  inFlight.set(reservationId, task);
  return task;
}

async function doPush(reservationId: string): Promise<SyncOutcome> {
  const started = Date.now();

  const res = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { guest: true, room: { include: { roomType: true } } },
  });
  if (!res) return { status: "skipped", reason: "bron topilmadi (o'chirilgan)" };

  // --- 0. Ulanish ---
  // Beds24 ulanmagan — bron PENDING qoladi, ulangandan keyin catch-up yuboradi
  if (!(await activeConnection())) {
    return { status: "skipped", reason: "Beds24 ulanmagan" };
  }

  // --- 1. Beds24'da hali yo'q va endi kerak ham emas ---
  // Tugagan, bekor qilingan, kelmagan bronni Beds24'da YANGI bron qilib
  // yaratish ma'nosiz (tarix) — faqat mavjudini yangilash mumkin
  const finished = res.status === "CANCELLED" || res.status === "NO_SHOW" || res.status === "CHECKED_OUT"
    || res.checkOut <= hotelToday();
  if (!res.externalReservationId && finished) {
    await markSync(res.id, "NOT_APPLICABLE", null);
    return { status: "skipped", reason: "bron tugagan yoki bekor qilingan — Beds24'da yaratilmaydi" };
  }

  // Qo'lda kiritilgan OTA broni (Booking.com va h.k.) Beds24'da ALLAQACHON
  // bor — OTA uni Beds24'ga o'zi yuborgan. PMS uni yangi bron qilib
  // yuborsa Beds24'da ikkinchi nusxa paydo bo'lardi. Import uni OTA
  // raqami / sanalar bo'yicha topib bog'laydi (webhookProcessor.ts)
  if (!res.externalReservationId && res.origin === "PMS" && OTA_SOURCES.has(res.source)) {
    await markSync(
      res.id,
      "NOT_APPLICABLE",
      "OTA broni Beds24'ga yuborilmaydi — Beds24'dagi asl bron bilan bog'lanadi (OTA raqamini kiriting)"
    );
    return { status: "skipped", reason: "qo'lda kiritilgan OTA broni" };
  }

  // --- 2. Mapping majburiy ---
  // Taxminiy mapping ASLO ishlatilmaydi: noto'g'ri turga ketgan bron real
  // overbooking keltiradi. XONA bog'lanishi ustuvor (egasi Beds24'da har
  // "Room" ni bitta aniq xona qilgan: Room 1 = 101), bo'lmasa — tur.
  const [roomMapping, typeMapping] = await Promise.all([
    findRoomMapping(res.roomId),
    findRoomTypeMapping(res.room.roomTypeId),
  ]);
  const externalRoomTypeId = roomMapping?.externalRoomTypeId ?? typeMapping?.externalRoomTypeId ?? null;
  if (!externalRoomTypeId) {
    // Mapping o'z-o'zidan paydo bo'lmaydi — qayta urinish foydasiz.
    // Bog'langanda `requeueAfterMappingChange` qayta yuboradi. Jurnalga
    // FAILED yozilmaydi: bog'lanmagan xona — xato emas, sozlama holati
    await markSync(res.id, "NOT_APPLICABLE", `${res.roomId}-xona Beds24 bilan bog'lanmagan (mapping)`);
    return { status: "skipped", reason: `mapping yo'q: ${res.roomId}-xona (${res.room.roomTypeId})` };
  }

  // --- 3. Payload ---
  const { first, last } = splitName(res.guest.fullName);
  const statusPair = toBeds24Status(res.status);
  const flag = otaFlagFor(res.status);
  const nightCount = nightsBetween(res.checkIn, res.checkOut);

  // Unit — xona darajasidagi mapping'dan (Q6). Bo'lmasa Beds24 o'zi tanlaydi
  const externalUnitId =
    roomMapping?.externalRoomTypeId === externalRoomTypeId
      ? roomMapping.externalUnitId ?? undefined
      : undefined;

  // Narx Beds24 obyekti valyutasida (Q15). Bron o'sha valyutada bo'lsa —
  // o'zgarishsiz; so'm bron (sayt, qabulxona) — bugungi kurs bilan
  // dollarga. Kurs yoki Beds24 valyutasi noma'lum bo'lsa narxsiz
  // yuboriladi (450 000 so'm Beds24'da $450 000 bo'lib ketmasin).
  const channelCurrency = (await getChannel().getCurrency().catch(() => "")).toUpperCase();
  const resCurrency = res.currency.toUpperCase();
  let divisor: number | null = null;
  if (channelCurrency !== "") {
    if (channelCurrency === resCurrency) divisor = 1;
    else if (isBaseCurrency(resCurrency)) divisor = await rateFor(channelCurrency);
  }

  const payload = {
    ...(res.externalReservationId ? { externalId: res.externalReservationId } : {}),
    externalRoomTypeId,
    ...(externalUnitId ? { externalUnitId } : {}),
    status: statusPair.status,
    ...(statusPair.subStatus ? { subStatus: statusPair.subStatus } : {}),
    ...(flag ? { flagText: flag.flagText, flagColor: flag.flagColor } : {}),
    checkIn: toDateKey(res.checkIn) ?? "",
    checkOut: toDateKey(res.checkOut) ?? "",
    adults: res.adults,
    children: res.children,
    // Faqat xona (nonushta va xizmatlar PMS'da): aks-sado narxni
    // o'zgarishsiz qaytaradi. Sentgacha — lib/money.ts bilan bir xil
    ...(divisor !== null ? { totalPrice: round2(roomTotalFor(res.pricePerNight, nightCount) / divisor) } : {}),
    guestFirstName: first,
    guestLastName: last,
    ...(res.guest.phone ? { phone: res.guest.phone } : {}),
    ...(res.guest.email ? { email: res.guest.email } : {}),
    ...(res.notes ? { notes: res.notes } : {}),
    ...(res.externalReservationId ? { mode: pushModeFor(res) } : {}),
  };

  // --- 4. Poyga himoyasi (jarayonlararo) ---
  // Faqat YANGI bron uchun: `updateMany` + `where` atomar — bitta jarayon
  // band qiladi, qolganlari uning id'sini kutadi. Aks holda ikki jarayon
  // Beds24'da ikkita bron yaratardi.
  let existingId = res.externalReservationId;
  if (!existingId) {
    const staleClaim = new Date(Date.now() - STALE_CLAIM_MS);
    const claimed = await prisma.reservation.updateMany({
      where: {
        id: res.id,
        externalReservationId: null,
        OR: [{ syncStatus: { not: "SYNCING" } }, { updatedAt: { lt: staleClaim } }],
      },
      data: { syncStatus: "SYNCING" },
    });
    if (claimed.count === 0) {
      const settled = await waitForExternalId(res.id);
      if (!settled) {
        return { status: "failed", error: "bron hozir boshqa jarayon tomonidan yuborilmoqda", retryable: true };
      }
      existingId = settled;
      (payload as { externalId?: string }).externalId = settled;
    }
  }

  const result = await getChannel().pushReservation(payload);
  const durationMs = Date.now() - started;

  if (!result.ok) {
    const retryable = result.retryable !== false;
    await markSync(res.id, retryable ? "FAILED" : "REJECTED", result.error);
    await logPush("push_reservation", "FAILED", {
      reservationId: res.id,
      roomId: res.roomId,
      request: payload,
      errorMessage: result.error,
      durationMs,
    });
    return retryable
      ? { status: "failed", error: result.error, retryable: true }
      : { status: "rejected", error: result.error };
  }

  // --- 5. Yangi bron id'si ---
  const wasCreated = !existingId;
  if (wasCreated && result.externalId) {
    const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
    try {
      await prisma.reservation.update({
        where: { id: res.id },
        data: {
          externalReservationId: result.externalId,
          ...(channel ? { channelId: channel.id } : {}),
          syncStatus: "SYNCED",
          syncError: null,
          lastSyncedAt: new Date(),
        },
      });
      await notifyReservation("reservation.updated", res.id);
    } catch (e) {
      // P2002 — parallel chaqiruv bizdan oldin yozib ulgurgan: sinxronlangan
      if ((e as { code?: string }).code !== "P2002") throw e;
      await markSync(res.id, "SYNCED", null);
    }
  } else {
    await markSync(res.id, "SYNCED", null);
  }

  await logPush("push_reservation", "SUCCESS", {
    reservationId: res.id,
    roomId: res.roomId,
    request: payload,
    response: { externalId: result.externalId, created: wasCreated, detail: result.detail },
    durationMs,
  });

  return { status: "sent", externalId: result.externalId, created: wasCreated };
}

// ============================================================
//  2. Navbatga qo'yish
// ============================================================

/**
 * Bron sinxronini navbatga qo'yadi.
 *
 * `jobId` bron + amal + oyna bo'yicha: bir xil amal oyna ichida takrorlansa
 * birlashadi. Kechikish = oyna uzunligi, vazifa bazadagi OXIRGI holatni
 * yuboradi. Kechikishsiz (ilgari) ikkinchi o'zgarish bajarilayotgan
 * birinchi vazifaning id'siga urilib tashlanardi va birinchisi bronni
 * SYNCED deb belgilardi — o'zgarish Beds24'ga yetmay qolardi.
 *
 * Redis yo'q bo'lsa xato TASHLANMAYDI — bron PMS'da baribir yaratilgan
 * (TZ 17, 19-band); `syncStatus` PENDING qoladi, catch-up yuboradi.
 */
export async function enqueueReservationSync(
  reservationId: string,
  changeType: ChangeType,
  opts: { previousState?: ReservationSyncJob["previousState"]; triggeredBy?: string } = {}
): Promise<{ queued: boolean; jobId?: string }> {
  // BullMQ `jobId`da ":" taqiqlangan. Oyna raqami — tugagan job 24 soat
  // saqlanib, o'sha id'ni bloklab qo'ymasligi uchun
  const window = Math.floor(Date.now() / RES_SYNC_WINDOW_MS);
  const jobId = `res_${reservationId}_${changeType}_${window}`;

  const added = await enqueueWithTimeout(
    () => reservationSyncQueue.add(
      "sync",
      {
        reservationId,
        changeType,
        previousState: opts.previousState,
        triggeredBy: opts.triggeredBy,
        requestedAt: new Date().toISOString(),
      },
      { jobId, delay: RES_SYNC_WINDOW_MS },
    ),
    `reservation-sync (${changeType})`
  );
  return added ? { queued: true, jobId } : { queued: false };
}

/**
 * Bron o'zgarganda chaqiriladi — `syncStatus = PENDING` + navbat.
 *
 * Beds24 ulanmagan bo'lsa ham PENDING qo'yiladi: ulangandan keyin
 * catch-up faol bronlarni yuboradi (OTA shu xonalarni sotmasin).
 */
export async function onReservationChanged(
  reservationId: string,
  changeType: ChangeType,
  opts: { previousState?: ReservationSyncJob["previousState"]; triggeredBy?: string } = {}
): Promise<void> {
  await prisma.reservation
    .update({ where: { id: reservationId }, data: { syncStatus: "PENDING", syncError: null } })
    .catch(() => {});

  if (!(await activeConnection())) return;
  await enqueueReservationSync(reservationId, changeType, opts);
}

// ============================================================
//  3. Qolib ketganlarni yuborish (catch-up) va qo'lda qayta yuborish
// ============================================================

/**
 * Yuborilmay qolgan bronlar: vaqtinchalik xato (FAILED), eski PENDING
 * (Redis o'chiq edi yoki Beds24 ulanmagan edi), osilib qolgan SYNCING.
 *
 * REJECTED va NOT_APPLICABLE KIRMAYDI — ular avtomatik qayta
 * yuborilmaydi (2026-09-26 dagi shovqin sababi). Xodim bronni
 * o'zgartirsa yoki "Qayta yuborish" bossa — yana PENDING bo'ladi.
 *
 * "Eski PENDING": hozirgina yaratilgan bron ham PENDING — uning job'i
 * navbatda turibdi. 2 daqiqadan eskisi navbat allaqachon bajargan yoki
 * umuman qo'yilmagan.
 */
export async function resyncPending(limit = 50): Promise<{ total: number; sent: number; failed: number; rejected: number }> {
  if (!(await activeConnection())) return { total: 0, sent: 0, failed: 0, rejected: 0 };

  const staleAfter = new Date(Date.now() - STALE_CLAIM_MS);
  const pending = await prisma.reservation.findMany({
    where: {
      OR: [
        { syncStatus: "FAILED" },
        { syncStatus: "PENDING", updatedAt: { lt: staleAfter } },
        { syncStatus: "SYNCING", updatedAt: { lt: staleAfter } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let sent = 0;
  let failed = 0;
  let rejected = 0;
  for (const r of pending) {
    const outcome = await pushReservation(r.id);
    if (outcome.status === "sent") sent++;
    else if (outcome.status === "failed") failed++;
    else if (outcome.status === "rejected") {
      rejected++;
      notifySyncFailed("push_reservation", outcome.error, r.id, { telegram: true });
    }
  }
  return { total: pending.length, sent, failed, rejected };
}

/**
 * Xodim "Qayta yuborish" bosdi (REJECTED / FAILED bron): holat PENDING
 * bo'ladi va darhol yuboriladi. Natija javobda qaytadi.
 */
export async function retryReservationSync(reservationId: string): Promise<SyncOutcome> {
  await prisma.reservation.update({
    where: { id: reservationId },
    data: { syncStatus: "PENDING", syncError: null },
  });
  return pushReservation(reservationId);
}
