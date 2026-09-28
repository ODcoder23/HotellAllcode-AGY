/**
 * Xona yopilishi <-> Beds24 `black` bron (2026-09-25, ISH_REJASI B2).
 *
 * MUAMMO
 * ------
 * Mijoz qarori Q9 ("Beds24 tanlovi doim ustuvor"): PMS Beds24'ga bo'sh
 * xona sonini (`numAvail`) YOZMAYDI —
 * Beds24 uni bronlardan o'zi hisoblaydi. Natijada PMS'da ta'mirga
 * yopilgan xona Beds24'ga hech qanday yo'l bilan yetmasdi: Booking.com
 * uni sotishda davom etardi. Teskarisi ham: Beds24 panelida yopilgan
 * xona PMS'da faqat "admin qo'lda yopsin" ogohlantirishi bo'lardi.
 *
 * YECHIM — ikki yo'nalish, bitta jadval (`ChannelBlock`)
 * ------------------------------------------------------
 *   PMS -> Beds24  `syncRoomBlocks(roomId)`: PMS'dagi yopiq kunlar
 *                  (`RoomDayStatus.isBlocked`) ketma-ket oraliqlarga
 *                  yig'iladi va Beds24'dagi `black` bronlar bilan
 *                  solishtiriladi: yangisi yaratiladi, keragi qolmagani
 *                  bekor qilinadi. Diff asosida — shuning uchun qayta
 *                  chaqirish xavfsiz (catch-up shu funksiyani chaqiradi).
 *
 *   Beds24 -> PMS  `applyChannelBlock(ext)`: webhook yoki polling'dan
 *                  kelgan `black` bron PMS kunlarini yopadi, bekor
 *                  qilinsa ochadi, sanasi o'zgarsa ko'chiradi.
 *
 * EGALIK (Q9)
 *   origin = CHANNEL — Beds24 yopgan kunni PMS ocholmaydi (409), Beds24'da
 *                      ochiladi. OTA bronidagi qoida bilan bir xil.
 *   origin = PMS     — PMS boshqaradi; lekin Beds24 panelida bekor qilinsa
 *                      yoki ko'chirilsa, Beds24 ustuvor — PMS ham ergashadi.
 *
 * Beds24 yopgan kunlar `blockReason` da "Beds24:" bilan belgilanadi —
 * ochishda faqat shu kunlar ochiladi, xodim qo'lda yopgan kunlarga
 * tegilmaydi.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { fromDateKey, toDateKey } from "../lib/serialize.js";
import { logSync } from "../lib/syncLog.js";
import { getChannel } from "./channel/registry.js";
import type { ExternalReservation } from "./channel/types.js";
import { findByExternal, findRoomMapping, findRoomTypeMapping } from "./mapping.js";
import { getConnectionStatus } from "./beds24/auth.js";
import { hotelToday } from "../lib/hotelTime.js";
import { onAvailabilityChanged } from "./availability.js";

const DAY_MS = 86_400_000;
/** Yuborish shundan uzoq SYNCING da qolsa — jarayon o'lgan, qayta olinadi */
const STALE_CLAIM_MS = 2 * 60_000;
/** Yopish/ochish Beds24'ga shu oyna ichida bitta vazifa bo'lib ketadi */
const BLOCK_SYNC_WINDOW_MS = 3000;
/** Beds24 yopgan kunlar belgisi (`RoomDayStatus.blockReason`) */
export const CHANNEL_REASON_PREFIX = "Beds24:";

type Range = { from: Date; toEx: Date; reason: string | null };

export type BlockSyncResult = {
  roomId: string;
  created: number;
  cancelled: number;
  failed: number;
  skipped?: string;
};

export type ChannelBlockResult = {
  status: "processed" | "skipped" | "needs_manual_action";
  detail: string;
};

// ============================================================
//  Yordamchi
// ============================================================

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function eachDay(from: Date, toEx: Date): Date[] {
  const out: Date[] = [];
  for (let t = from.getTime(); t < toEx.getTime(); t += DAY_MS) out.push(new Date(t));
  return out;
}

/** Tartiblangan kunlardan ketma-ket `[from, toEx)` oraliqlar */
function toRanges(days: Array<{ date: Date; reason: string | null }>): Range[] {
  const sorted = [...days].sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: Range[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && last.toEx.getTime() === d.date.getTime()) {
      last.toEx = addDays(d.date, 1);
    } else {
      out.push({ from: d.date, toEx: addDays(d.date, 1), reason: d.reason });
    }
  }
  return out;
}

const sameRange = (a: { fromDate: Date; toDate: Date }, b: Range) =>
  a.fromDate.getTime() === b.from.getTime() && a.toDate.getTime() === b.toEx.getTime();

async function beds24ChannelId(): Promise<string | null> {
  const ch = await prisma.channel.findUnique({ where: { code: "beds24" }, select: { id: true } });
  return ch?.id ?? null;
}

/** Xona -> Beds24 room type (+ unit). Unit bo'lmasa Beds24 unitni o'zi tanlaydi */
async function externalTarget(roomId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { roomTypeId: true } });
  if (!room) return null;
  const [roomMap, typeMap] = await Promise.all([
    findRoomMapping(roomId),
    findRoomTypeMapping(room.roomTypeId),
  ]);
  const externalRoomTypeId = roomMap?.externalRoomTypeId ?? typeMap?.externalRoomTypeId ?? null;
  if (!externalRoomTypeId) return null;
  return {
    roomTypeId: room.roomTypeId,
    externalRoomTypeId,
    externalUnitId:
      roomMap?.externalRoomTypeId === externalRoomTypeId ? roomMap.externalUnitId ?? undefined : undefined,
  };
}

/** Kunlarni yopadi/ochadi va availability zanjirini ishga tushiradi */
async function setDays(
  roomId: string,
  from: Date,
  toEx: Date,
  blocked: boolean,
  reason: string | null,
  onlyChannelDays = false
): Promise<number> {
  let changed = 0;
  if (blocked) {
    for (const date of eachDay(from, toEx)) {
      await prisma.roomDayStatus.upsert({
        where: { roomId_date: { roomId, date } },
        create: { roomId, date, isBlocked: true, blockReason: reason },
        update: { isBlocked: true, blockReason: reason },
      });
      changed++;
    }
  } else {
    const r = await prisma.roomDayStatus.updateMany({
      where: {
        roomId,
        date: { gte: from, lt: toEx },
        isBlocked: true,
        ...(onlyChannelDays ? { blockReason: { startsWith: CHANNEL_REASON_PREFIX } } : {}),
      },
      data: { isBlocked: false, blockReason: null },
    });
    changed = r.count;
  }

  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { roomTypeId: true } });
  if (room) {
    await onAvailabilityChanged([room.roomTypeId], from, toEx, blocked ? "channel_block" : "channel_unblock");
  }
  return changed;
}

// ============================================================
//  1. PMS -> Beds24
// ============================================================

/**
 * Bitta xonaning PMS yopiqlarini Beds24 bilan tenglashtiradi.
 *
 * Ikki bosqich:
 *   1. Tranzaksiya + xona qulfi (`pg_advisory_xact_lock`): kerakli
 *      oraliqlar hisoblanadi, yangi qatorlar PENDING yaratiladi,
 *      keragi qolmaganlari `isActive = false` qilinadi. Tez, tashqi
 *      so'rovsiz — ikki jarayon bir oraliqni ikki marta yaratolmaydi.
 *   2. Kutayotgan har qator band qilinadi (`updateMany`) va Beds24'ga
 *      yuboriladi. Yiqilsa FAILED — catch-up qayta uradi.
 */
export async function syncRoomBlocks(roomId: string): Promise<BlockSyncResult> {
  const result: BlockSyncResult = { roomId, created: 0, cancelled: 0, failed: 0 };

  const [status, channelId] = await Promise.all([getConnectionStatus(), beds24ChannelId()]);
  if (!status.isConnected || !channelId) return { ...result, skipped: "Beds24 ulanmagan" };

  const target = await externalTarget(roomId);
  if (!target) return { ...result, skipped: "xona turi Beds24 bilan bog'lanmagan (mapping)" };

  const today = hotelToday();

  // --- 1-bosqich: diff ---
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"channel_block:" + roomId}))`;

    const existing = await tx.channelBlock.findMany({
      where: { channelId, roomId, origin: "PMS", isActive: true, toDate: { gt: today } },
    });

    // Boshlanishi o'tmishda qolgan faol yopish ham solishtirilsin —
    // aks holda har kuni "o'zgardi" deb qayta yaratilardi
    // Yuqori chegara yo'q: kelajakdagi HAR QANDAY yopish OTA'ga yetishi
    // kerak (bir amal 366 kungacha, lekin istalgan sanaga yopiladi)
    const start = existing.reduce((m, e) => (e.fromDate < m ? e.fromDate : m), today);

    const [days, channelBlocks] = await Promise.all([
      tx.roomDayStatus.findMany({
        where: { roomId, isBlocked: true, date: { gte: start } },
        select: { date: true, blockReason: true },
      }),
      tx.channelBlock.findMany({
        where: { channelId, roomId, origin: "CHANNEL", isActive: true, toDate: { gt: start } },
        select: { fromDate: true, toDate: true },
      }),
    ]);

    // Beds24 o'zi yopgan kunlar qayta yuborilmaydi (aks-sado bo'lardi)
    const covered = new Set<number>();
    for (const b of channelBlocks) {
      for (const d of eachDay(b.fromDate, b.toDate)) covered.add(d.getTime());
    }
    const desired = toRanges(
      days
        .filter((d) => !covered.has(d.date.getTime()))
        .filter((d) => !(d.blockReason ?? "").startsWith(CHANNEL_REASON_PREFIX))
        .map((d) => ({ date: d.date, reason: d.blockReason }))
    );

    const keep = new Set<string>();
    for (const r of desired) {
      const match = existing.find((e) => sameRange(e, r) && !keep.has(e.id));
      if (match) {
        keep.add(match.id);
        continue;
      }
      await tx.channelBlock.create({
        data: {
          channelId, roomId, origin: "PMS",
          fromDate: r.from, toDate: r.toEx,
          reason: r.reason, syncStatus: "PENDING",
        },
      });
    }

    for (const e of existing) {
      if (keep.has(e.id)) continue;
      await tx.channelBlock.update({
        where: { id: e.id },
        // Beds24'ga yetmagan yopishni bekor qilish shart emas
        data: { isActive: false, syncStatus: e.externalId ? "PENDING" : "SYNCED", syncError: null },
      });
    }
  });

  // --- 2-bosqich: yuborish ---
  const staleClaim = new Date(Date.now() - STALE_CLAIM_MS);
  const pending = await prisma.channelBlock.findMany({
    where: {
      channelId, roomId, origin: "PMS",
      OR: [
        { syncStatus: { in: ["PENDING", "FAILED"] } },
        { syncStatus: "SYNCING", updatedAt: { lt: staleClaim } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });

  for (const b of pending) {
    const creating = b.isActive && !b.externalId;
    const cancelling = !b.isActive && !!b.externalId;
    if (!creating && !cancelling) {
      await prisma.channelBlock.update({ where: { id: b.id }, data: { syncStatus: "SYNCED" } });
      continue;
    }

    const claimed = await prisma.channelBlock.updateMany({
      where: { id: b.id, syncStatus: b.syncStatus, updatedAt: b.updatedAt },
      data: { syncStatus: "SYNCING" },
    });
    if (claimed.count === 0) continue;   // boshqa jarayon yubormoqda

    const started = Date.now();
    const push = await getChannel().pushBlock({
      externalId: b.externalId ?? undefined,
      externalRoomTypeId: target.externalRoomTypeId,
      externalUnitId: target.externalUnitId,
      checkIn: toDateKey(b.fromDate) ?? "",
      checkOut: toDateKey(b.toDate) ?? "",
      note: b.reason ? `PMS: ${b.reason}` : "PMS: xona yopiq",
      cancel: cancelling,
    });

    if (push.ok) {
      await prisma.channelBlock.update({
        where: { id: b.id },
        data: {
          syncStatus: "SYNCED",
          syncError: null,
          ...(creating && push.externalId ? { externalId: push.externalId } : {}),
        },
      });
      if (creating) result.created++;
      else result.cancelled++;
    } else {
      await prisma.channelBlock.update({
        where: { id: b.id },
        data: { syncStatus: "FAILED", syncError: push.error.slice(0, 500) },
      });
      result.failed++;
    }

    await logSync({
      action: creating ? "push_room_block" : "cancel_room_block",
      direction: "PMS_TO_CHANNEL",
      status: push.ok ? "SUCCESS" : "FAILED",
      roomId,
      request: { from: toDateKey(b.fromDate), to: toDateKey(b.toDate), externalId: b.externalId },
      errorMessage: push.ok ? undefined : push.error,
      durationMs: Date.now() - started,
    });
  }

  return result;
}

/**
 * Bir necha xona uchun — `blockRooms`/`unblockRooms` dan keyin.
 *
 * Xato yutiladi: yopish PMS'da allaqachon saqlangan, Beds24'ga
 * yetmagani FAILED bo'lib qoladi va catch-up qayta yuboradi.
 */
export async function syncRoomBlocksSafe(roomIds: string[]): Promise<BlockSyncResult[]> {
  const out: BlockSyncResult[] = [];
  for (const id of roomIds) {
    try {
      out.push(await syncRoomBlocks(id));
    } catch (e) {
      console.warn(`[blocks] ${id} Beds24'ga yuborilmadi: ${String(e).slice(0, 150)}`);
      out.push({ roomId: id, created: 0, cancelled: 0, failed: 1, skipped: String(e).slice(0, 150) });
    }
  }
  return out;
}

/**
 * Yopish/ochishdan keyin: `beds24-availability-sync` navbatiga (TZ 6,
 * 11-band). Redis javob bermasa — fonda to'g'ridan-to'g'ri (natija
 * kutilmaydi); yiqilsa FAILED bo'lib qoladi, catch-up qayta yuboradi.
 */
export async function enqueueBlockSync(roomIds: string[], reason: string): Promise<void> {
  if (roomIds.length === 0) return;
  const status = await getConnectionStatus();
  if (!status.isConnected) return;

  const { availabilitySyncQueue, enqueueWithTimeout } = await import("../queues/index.js");
  // Kechikish = oyna uzunligi: vazifa oyna tugagandan keyin ishlaydi, shu
  // oynadagi hamma o'zgarish unga qo'shiladi. Kechikish qisqa bo'lganda
  // (ilgari 1 s) yopib darhol ochilgan xonaning ikkinchi vazifasi bajarilgan
  // birinchisining id'siga urilib tashlanardi — Beds24'da `black` qolardi
  const window = Math.floor(Date.now() / BLOCK_SYNC_WINDOW_MS);
  const ids = [...new Set(roomIds)].sort();
  const queued = await enqueueWithTimeout(
    () => availabilitySyncQueue.add(
      "blocks",
      { roomIds: ids, reason },
      { jobId: `blocks_${ids.join("-").slice(0, 150)}_${window}`, delay: BLOCK_SYNC_WINDOW_MS }
    ),
    `availability-sync (${reason})`
  );
  if (!queued) void syncRoomBlocksSafe(ids);
}

/**
 * Hamma xonalar — catch-up (har 15 daqiqa) va Beds24 ulangandan keyin.
 * Yopig'i bor yoki yuborilmagan yozuvi bor xonalargina tekshiriladi.
 */
export async function syncAllRoomBlocks(): Promise<{ rooms: number; created: number; cancelled: number; failed: number }> {
  const status = await getConnectionStatus();
  if (!status.isConnected) return { rooms: 0, created: 0, cancelled: 0, failed: 0 };

  const today = hotelToday();
  const [days, rows] = await Promise.all([
    prisma.roomDayStatus.findMany({
      where: { isBlocked: true, date: { gte: today } },
      select: { roomId: true },
      distinct: ["roomId"],
    }),
    prisma.channelBlock.findMany({
      where: {
        origin: "PMS",
        OR: [{ isActive: true, toDate: { gt: today } }, { syncStatus: { not: "SYNCED" } }],
      },
      select: { roomId: true },
      distinct: ["roomId"],
    }),
  ]);

  const roomIds = [...new Set([...days.map((d) => d.roomId), ...rows.map((r) => r.roomId)])];
  const results = await syncRoomBlocksSafe(roomIds);
  return {
    rooms: roomIds.length,
    created: results.reduce((s, r) => s + r.created, 0),
    cancelled: results.reduce((s, r) => s + r.cancelled, 0),
    failed: results.reduce((s, r) => s + r.failed, 0),
  };
}

/**
 * PMS'da ochishdan oldin: Beds24 yopgan kunni PMS ochmaydi (Q9).
 * OTA bronidagi `CHANNEL_OWNED` qoidasi bilan bir xil.
 */
export async function assertNoChannelBlocks(roomIds: string[], from: Date, toEx: Date): Promise<void> {
  const found = await prisma.channelBlock.findFirst({
    where: {
      roomId: { in: roomIds },
      origin: "CHANNEL",
      isActive: true,
      fromDate: { lt: toEx },
      toDate: { gt: from },
    },
    select: { roomId: true, fromDate: true, toDate: true },
  });
  if (!found) return;

  const last = addDays(found.toDate, -1);
  throw new AppError(
    409,
    `${found.roomId}-xona Beds24'da yopilgan (${toDateKey(found.fromDate)}..${toDateKey(last)}). ` +
    `U Beds24 panelida ochiladi — o'zgarish PMS'ga o'zi keladi.`,
    "CHANNEL_OWNED"
  );
}

// ============================================================
//  2. Beds24 -> PMS
// ============================================================

/** Bu tashqi yozuv yopish bilan bog'liqmi (webhook yo'naltirishi uchun) */
export async function findChannelBlock(externalId: string) {
  const channelId = await beds24ChannelId();
  if (!channelId) return null;
  return prisma.channelBlock.findUnique({
    where: { channelId_externalId: { channelId, externalId } },
  });
}

/**
 * Beds24'dan kelgan `black` bron (yoki uning bekor qilinishi) PMS'ga.
 *
 * `processWebhookEvent` va polling ikkalasi `applyReservation` orqali
 * shu yerga keladi — bitta yo'l.
 */
export async function applyChannelBlock(ext: ExternalReservation): Promise<ChannelBlockResult> {
  const channelId = await beds24ChannelId();
  if (!channelId) return { status: "skipped", detail: "Beds24 kanali yo'q" };

  const isBlack = ext.status.toLowerCase() === "black";
  const from = fromDateKey(ext.checkIn);
  const toEx = fromDateKey(ext.checkOut);

  let row = await prisma.channelBlock.findUnique({
    where: { channelId_externalId: { channelId, externalId: ext.externalId } },
  });

  // --- Bizning yopishimiz, lekin id hali saqlanmagan (poyga) ---
  if (!row && isBlack && ext.isOwnEcho) {
    const target = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
    if (target?.roomId) {
      const own = await prisma.channelBlock.findFirst({
        where: { channelId, roomId: target.roomId, origin: "PMS", externalId: null, fromDate: from, toDate: toEx },
      });
      if (own) {
        if (own.isActive) {
          await prisma.channelBlock.update({
            where: { id: own.id },
            data: { externalId: ext.externalId, syncStatus: "SYNCED", syncError: null },
          });
          return { status: "skipped", detail: `O'z yopishimiz (#${ext.externalId}) — bog'landi` };
        }
      }
    }
    // PMS'da endi yopiq emas — Beds24'dagi eski yopishni tozalaymiz
    const cancel = await getChannel().pushBlock({
      externalId: ext.externalId,
      externalRoomTypeId: ext.externalRoomTypeId,
      checkIn: ext.checkIn,
      checkOut: ext.checkOut,
      cancel: true,
    });
    return cancel.ok
      ? { status: "processed", detail: `Egasiz PMS yopishi #${ext.externalId} Beds24'da bekor qilindi` }
      : { status: "needs_manual_action", detail: `Egasiz PMS yopishi #${ext.externalId} bekor qilinmadi: ${cancel.error}` };
  }

  // --- Yangi yopish (Beds24 panelida) ---
  if (!row) {
    if (!isBlack) return { status: "skipped", detail: `Yopish #${ext.externalId} PMS'da yo'q` };

    const target = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
    if (!target?.roomId) {
      return {
        status: "needs_manual_action",
        detail:
          `Beds24'da xona yopildi (black #${ext.externalId}): room ${ext.externalRoomTypeId}` +
          `${ext.externalUnitId ? `/unit ${ext.externalUnitId}` : ""}, ${ext.checkIn}..${ext.checkOut}, ` +
          `lekin bu unit PMS xonasiga bog'lanmagan. /admin/mapping da "Unitlarni bog'lash" ni bosing ` +
          `yoki xonani PMS'da qo'lda yoping.`,
      };
    }

    try {
      row = await prisma.channelBlock.create({
        data: {
          channelId, roomId: target.roomId, origin: "CHANNEL",
          fromDate: from, toDate: toEx, externalId: ext.externalId,
          reason: ext.notes?.slice(0, 200) ?? null,
          syncStatus: "SYNCED",
        },
      });
    } catch (e) {
      // Parallel webhook allaqachon yaratgan
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return { status: "skipped", detail: `Yopish #${ext.externalId} allaqachon qayd etilgan` };
      }
      throw e;
    }

    await setDays(row.roomId, from, toEx, true, channelReason(ext.notes));
    return withConflict(
      `Beds24'da yopildi: ${row.roomId}-xona ${ext.checkIn}..${ext.checkOut}`,
      await conflictNote(row.roomId, from, toEx)
    );
  }

  // --- Mavjud yopish ---
  const onlyChannelDays = row.origin === "CHANNEL";

  if (!isBlack) {
    if (!row.isActive) return { status: "skipped", detail: `Yopish #${ext.externalId} allaqachon ochilgan` };
    // Beds24'da ochildi (panelda bekor qilindi) — Beds24 ustuvor (Q9)
    await prisma.channelBlock.update({
      where: { id: row.id },
      data: { isActive: false, syncStatus: "SYNCED", syncError: null },
    });
    await setDays(row.roomId, row.fromDate, row.toDate, false, null, onlyChannelDays);
    return {
      status: "processed",
      detail: `Beds24'da ochildi: ${row.roomId}-xona ${toDateKey(row.fromDate)}..${toDateKey(row.toDate)}`,
    };
  }

  const target = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);
  const roomId = target?.roomId ?? row.roomId;
  const unchanged =
    row.isActive && row.roomId === roomId &&
    row.fromDate.getTime() === from.getTime() && row.toDate.getTime() === toEx.getTime();
  if (unchanged) return { status: "skipped", detail: `Yopish #${ext.externalId} o'zgarmagan` };

  // Beds24'da sana yoki xona o'zgardi — PMS ergashadi
  if (row.isActive) await setDays(row.roomId, row.fromDate, row.toDate, false, null, onlyChannelDays);
  await prisma.channelBlock.update({
    where: { id: row.id },
    data: { roomId, fromDate: from, toDate: toEx, isActive: true, syncStatus: "SYNCED", syncError: null },
  });
  const reason = row.origin === "CHANNEL" ? channelReason(ext.notes) : row.reason;
  await setDays(roomId, from, toEx, true, reason);

  return withConflict(
    `Beds24'da yopish o'zgardi: ${roomId}-xona ${ext.checkIn}..${ext.checkOut}`,
    await conflictNote(roomId, from, toEx)
  );
}

/**
 * Yopilgan kunlarda PMS broni bo'lsa — kunlar baribir yopiladi (Beds24
 * ustuvor), lekin admin ko'rishi uchun NEEDS_MANUAL_ACTION.
 */
function withConflict(detail: string, note: string): ChannelBlockResult {
  return note
    ? { status: "needs_manual_action", detail: detail + note }
    : { status: "processed", detail };
}

function channelReason(notes?: string): string {
  const text = (notes ?? "").trim().slice(0, 150);
  return `${CHANNEL_REASON_PREFIX} ${text || "xona yopilgan"}`;
}

/** Yopilgan kunlarda PMS bronlari bo'lsa — xodim ko'rsin */
async function conflictNote(roomId: string, from: Date, toEx: Date): Promise<string> {
  const n = await prisma.reservation.count({
    where: {
      roomId,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      checkIn: { lt: toEx },
      checkOut: { gt: from },
    },
  });
  return n > 0 ? `. DIQQAT: shu kunlarda ${n} ta bron bor — boshqa xonaga ko'chiring` : "";
}
