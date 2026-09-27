/**
 * Sotuvni vaqtincha to'xtatish — "STOP" (egasi talabi, 2026-09-26).
 *
 * Mehmonxona dam olsa yoki ishlamasa admin Shaxmatka -> Sozlamalar ->
 * "Tizim nazorati" da STOP bosadi, "Barcha xonalar" (yoki ayrim xonalar)ni
 * tanlaydi va tasdiqlaydi. To'xtatilgan xonalarga:
 *
 *   - sayt: qidiruvda chiqmaydi ("bo'sh xona yo'q"), bron rad etiladi
 *   - qabulxona (Shaxmatka): yangi bron rad etiladi, jadval xiralashadi
 *
 * QANDAY YOPILADI: mavjud "xona yopish" mexanizmi orqali — kelgusi
 * `HORIZON_DAYS` kunning BO'SH kunlari `RoomDayStatus` da yopiladi
 * (`blockReason` "STOP:" bilan) va availability qayta hisoblanadi.
 *
 * MAVJUD BRONLAR SAQLANADI: bron bor kunlar yopilmaydi, mehmon kelsa
 * kirish, chiqish va to'lov ishlaydi. Stop paytida bron bekor qilinsa
 * bo'shagan kun davriy vazifada yopiladi (`enforceSalesStop`, har 15
 * daqiqa) — ufq ham har kuni oldinga suriladi.
 *
 * STOPDAN CHIQARISH faqat "STOP:" kunlarini ochadi: ta'mir kabi boshqa
 * sabab bilan yopilgan kunlarga tegilmaydi. O'tgan kunlar yopiq qoladi
 * (tarix: "o'sha kunlari mehmonxona ishlamagan").
 *
 * HOLAT: `Settings.SALES_STOP` (JSON) — server qayta ishga tushsa ham
 * saqlanadi. TARIX: audit jurnali. Egasiga Telegram xabari.
 */

import { prisma } from "../lib/prisma.js";
import { AppError, ValidationError } from "../lib/errors.js";
import { toDateKey } from "../lib/serialize.js";
import { hotelToday } from "../lib/hotelTime.js";
import { getSetting, setSetting } from "./settings.js";
import { onAvailabilityChanged } from "./availability.js";

export const SALES_STOP_KEY = "SALES_STOP";
/** `RoomDayStatus.blockReason` belgisi — faqat shu kunlar STOP'niki */
export const STOP_REASON_PREFIX = "STOP:";
/** Bugundan necha kun yopiladi — sayt sotadigan oraliq (1 yil) */
const HORIZON_DAYS = 366;
const DAY_MS = 86_400_000;

export type SalesStop = {
  active: boolean;
  /** Barcha xonalar — keyin qo'shilgan xona ham to'xtatiladi */
  allRooms: boolean;
  /** Ayrim xonalar (allRooms = false bo'lganda) */
  roomIds: string[];
  reason: string | null;
  /** ISO — qachon to'xtatilgan */
  since: string | null;
  /** Kim to'xtatgan (email) */
  by: string | null;
};

const INACTIVE: SalesStop = { active: false, allRooms: false, roomIds: [], reason: null, since: null, by: null };

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

// ============================================================
//  Holat
// ============================================================

export async function getSalesStop(): Promise<SalesStop> {
  const raw = await getSetting(SALES_STOP_KEY, "");
  if (!raw) return INACTIVE;
  try {
    const v = JSON.parse(raw) as Partial<SalesStop>;
    if (!v.active) return INACTIVE;
    return {
      active: true,
      allRooms: !!v.allRooms,
      roomIds: Array.isArray(v.roomIds) ? v.roomIds.map(String) : [],
      reason: v.reason ?? null,
      since: v.since ?? null,
      by: v.by ?? null,
    };
  } catch {
    return INACTIVE;
  }
}

/** To'xtatilgan faol xonalar. Stop yo'q bo'lsa — bo'sh */
export async function stoppedRoomIds(stop?: SalesStop): Promise<string[]> {
  const s = stop ?? (await getSalesStop());
  if (!s.active) return [];
  const rooms = await prisma.room.findMany({
    where: { isActive: true, ...(s.allRooms ? {} : { id: { in: s.roomIds } }) },
    select: { id: true },
    orderBy: { sortOrder: "asc" },
  });
  return rooms.map((r) => r.id);
}

/**
 * Yangi bronni to'xtatilgan xonaga qo'ymaslik (qabulxona, sayt).
 *
 * 409 `SALES_STOPPED`: Shaxmatka va sayt xabarni o'zgarishsiz ko'rsatadi.
 * Saytga ichki tafsilot (kim, nega) berilmaydi.
 */
export async function assertSalesOpen(roomId: string, audience: "staff" | "guest"): Promise<void> {
  const stop = await getSalesStop();
  if (!stop.active) return;
  const stopped = stop.allRooms || stop.roomIds.includes(roomId);
  if (!stopped) return;
  throw new AppError(
    409,
    audience === "guest"
      ? "Mehmonxona vaqtincha bron qabul qilmayapti. Iltimos, keyinroq urinib ko'ring."
      : `Tizim vaqtincha to'xtatilgan (STOP): ${stop.allRooms ? "barcha xonalar" : `${roomId}-xona`} ` +
        `yangi bron qabul qilmaydi. Sozlamalar -> Tizim nazorati'dan stopdan chiqaring.`,
    "SALES_STOPPED"
  );
}

// ============================================================
//  Yopish / ochish
// ============================================================

/**
 * To'xtatilgan xonalarning bo'sh kunlarini `[bugun, bugun + ufq)` da yopadi.
 *
 * Diff asosida — qayta chaqirish xavfsiz: allaqachon yopiq kun (STOP
 * yoki ta'mir) tegilmaydi, bron bor kun o'tkazib yuboriladi.
 * Qaytaradi: nechta (xona x kun) yopildi.
 */
async function applyStopBlocks(roomIds: string[], reason: string): Promise<number> {
  if (roomIds.length === 0) return 0;
  const today = hotelToday();
  const toEx = addDays(today, HORIZON_DAYS);

  const [rooms, reservations, existing] = await Promise.all([
    prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, roomTypeId: true } }),
    prisma.reservation.findMany({
      where: {
        roomId: { in: roomIds },
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
        checkIn: { lt: toEx },
        checkOut: { gt: today },
      },
      select: { roomId: true, checkIn: true, checkOut: true },
    }),
    prisma.roomDayStatus.findMany({
      where: { roomId: { in: roomIds }, date: { gte: today, lt: toEx } },
      select: { roomId: true, date: true, isBlocked: true },
    }),
  ]);

  // Bron bor kunlar — yopilmaydi (mavjud bronlar saqlanadi)
  const busy = new Set<string>();
  for (const r of reservations) {
    const from = r.checkIn > today ? r.checkIn : today;
    const to = r.checkOut < toEx ? r.checkOut : toEx;
    for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) busy.add(`${r.roomId}|${t}`);
  }
  const rowState = new Map(existing.map((e) => [`${e.roomId}|${e.date.getTime()}`, e.isBlocked]));

  const create: Array<{ roomId: string; date: Date; isBlocked: true; blockReason: string }> = [];
  const reopen = new Map<string, Date[]>();          // yozuvi bor, lekin ochiq kunlar
  for (const room of rooms) {
    for (let t = today.getTime(); t < toEx.getTime(); t += DAY_MS) {
      const k = `${room.id}|${t}`;
      if (busy.has(k)) continue;
      const state = rowState.get(k);
      if (state === undefined) create.push({ roomId: room.id, date: new Date(t), isBlocked: true, blockReason: reason });
      else if (!state) reopen.set(room.id, [...(reopen.get(room.id) ?? []), new Date(t)]);
    }
  }

  let changed = 0;
  for (let i = 0; i < create.length; i += 1000) {
    const r = await prisma.roomDayStatus.createMany({ data: create.slice(i, i + 1000), skipDuplicates: true });
    changed += r.count;
  }
  for (const [roomId, dates] of reopen) {
    const r = await prisma.roomDayStatus.updateMany({
      where: { roomId, date: { in: dates }, isBlocked: false },
      data: { isBlocked: true, blockReason: reason },
    });
    changed += r.count;
  }

  if (changed > 0) {
    const typeIds = [...new Set(rooms.map((r) => r.roomTypeId))];
    await onAvailabilityChanged(typeIds, today, toEx, "sales_stop");
  }
  return changed;
}

export type SalesStopResult = {
  stop: SalesStop;
  rooms: number;
  /** Nechta (xona x kun) yopildi / ochildi */
  days: number;
  /** To'xtatilgan xonalardagi kelgusi bronlar — saqlanadi */
  keptBookings: number;
};

async function futureBookings(roomIds: string[]): Promise<number> {
  if (roomIds.length === 0) return 0;
  return prisma.reservation.count({
    where: {
      roomId: { in: roomIds },
      status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] },
      checkOut: { gt: hotelToday() },
    },
  });
}

/** STOP — sotuvni to'xtatish */
export async function startSalesStop(
  input: { allRooms: boolean; roomIds?: string[]; reason?: string | null },
  actor: { email?: string | null } = {}
): Promise<SalesStopResult> {
  const current = await getSalesStop();
  if (current.active) {
    throw new AppError(409, "Tizim allaqachon to'xtatilgan — avval stopdan chiqaring.", "SALES_STOP_ACTIVE");
  }

  let roomIds: string[] = [];
  if (!input.allRooms) {
    roomIds = [...new Set((input.roomIds ?? []).map(String))];
    if (roomIds.length === 0) throw new ValidationError("Kamida bitta xonani yoki \"Barcha xonalar\" ni tanlang");
    const found = await prisma.room.findMany({ where: { id: { in: roomIds }, isActive: true }, select: { id: true } });
    const known = new Set(found.map((r) => r.id));
    const missing = roomIds.filter((id) => !known.has(id));
    if (missing.length > 0) throw new ValidationError(`Xona topilmadi: ${missing.join(", ")}`);
  }

  const reason = input.reason?.trim().slice(0, 120) || null;
  const stop: SalesStop = {
    active: true,
    allRooms: input.allRooms,
    roomIds,
    reason,
    since: new Date().toISOString(),
    by: actor.email ?? null,
  };
  // Avval holat yoziladi: yopish davomida kelgan bron ham rad etilsin
  await setSetting(SALES_STOP_KEY, JSON.stringify(stop), actor.email ?? undefined);

  const ids = await stoppedRoomIds(stop);
  const days = await applyStopBlocks(ids, `${STOP_REASON_PREFIX} ${reason ?? "vaqtincha to'xtatilgan"}`);
  return { stop, rooms: ids.length, days, keptBookings: await futureBookings(ids) };
}

/** Stopdan chiqarish — sotuv qayta ochiladi */
export async function releaseSalesStop(actor: { email?: string | null } = {}): Promise<SalesStopResult> {
  const current = await getSalesStop();
  if (!current.active) {
    throw new AppError(409, "Tizim to'xtatilmagan.", "SALES_STOP_INACTIVE");
  }

  const ids = await stoppedRoomIds(current);
  const today = hotelToday();
  const stopDays = { roomId: { in: ids }, date: { gte: today }, isBlocked: true, blockReason: { startsWith: STOP_REASON_PREFIX } };

  const last = await prisma.roomDayStatus.findFirst({ where: stopDays, orderBy: { date: "desc" }, select: { date: true } });
  const r = await prisma.roomDayStatus.updateMany({ where: stopDays, data: { isBlocked: false, blockReason: null } });

  await setSetting(SALES_STOP_KEY, JSON.stringify({ ...INACTIVE }), actor.email ?? undefined);

  if (r.count > 0 && last) {
    const rooms = await prisma.room.findMany({ where: { id: { in: ids } }, select: { roomTypeId: true } });
    await onAvailabilityChanged([...new Set(rooms.map((x) => x.roomTypeId))], today, addDays(last.date, 1), "sales_resume");
  }
  return { stop: { ...INACTIVE }, rooms: ids.length, days: r.count, keptBookings: 0 };
}

/**
 * Davriy vazifa (har 15 daqiqa, queues/scheduler.ts): stop faol bo'lsa
 * ufqni oldinga suradi va bekor qilingan bron bo'shatgan kunlarni yopadi.
 */
export async function enforceSalesStop(): Promise<number> {
  const stop = await getSalesStop();
  if (!stop.active) return 0;
  const ids = await stoppedRoomIds(stop);
  return applyStopBlocks(ids, `${STOP_REASON_PREFIX} ${stop.reason ?? "vaqtincha to'xtatilgan"}`);
}

/** Admin panel va Shaxmatka uchun: holat + tafsilot */
export async function salesStopStatus(): Promise<SalesStop & { stoppedRooms: string[]; keptBookings: number; blockedUntil: string | null }> {
  const stop = await getSalesStop();
  const ids = await stoppedRoomIds(stop);
  const last = stop.active
    ? await prisma.roomDayStatus.findFirst({
        where: { roomId: { in: ids }, isBlocked: true, blockReason: { startsWith: STOP_REASON_PREFIX } },
        orderBy: { date: "desc" },
        select: { date: true },
      })
    : null;
  return {
    ...stop,
    stoppedRooms: ids,
    keptBookings: stop.active ? await futureBookings(ids) : 0,
    blockedUntil: last ? toDateKey(last.date) : null,
  };
}

/**
 * Sayt broni: turning HAMMA xonasi to'xtatilgan bo'lsa — aniq xabar
 * ("vaqtincha bron qabul qilmayapti"). Ayrim xonalar to'xtatilgan
 * bo'lsa sayt boshqa bo'sh xonani tanlaydi (ularning kunlari yopiq).
 */
export async function assertTypeOpenForGuests(roomTypeId: string): Promise<void> {
  const stop = await getSalesStop();
  if (!stop.active) return;
  const rooms = await prisma.room.findMany({ where: { roomTypeId, isActive: true }, select: { id: true } });
  if (rooms.length === 0) return;
  if (stop.allRooms || rooms.every((r) => stop.roomIds.includes(r.id))) {
    await assertSalesOpen(rooms[0].id, "guest");
  }
}
