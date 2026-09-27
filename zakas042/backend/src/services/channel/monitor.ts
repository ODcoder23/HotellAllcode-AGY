/**
 * Kanal kuzatuvi (Beds24) — FAQAT O'QISH, FAQAT FOUNDER (2026-09-27)
 *
 * Egasi qarori: Beds24 integratsiyasi olib tashlangan (2026-09-26) va
 * shunday qoladi — qabulxona OTA bronlarini qo'lda kiritadi. Lekin
 * egasi Beds24 holatini ko'rib turishi kerak: u yerda qanday bron bor,
 * PMS'da hammasi kiritilganmi, Beds24 PMS band qilgan kunni sotib
 * qo'ymayaptimi, narxlar bir xilmi.
 *
 * Shuning uchun bu servis:
 *   - Beds24'dan O'QIYDI (bronlar, kalendar, obyekt) — `beds24/client.ts`
 *     faqat GET yuboradi
 *   - o'qilganini `ChannelBooking` / `ChannelCalendar` ga nusxalaydi
 *   - PMS bilan SOLISHTIRADI va natijani ko'rsatadi
 *   - PMS bronlari, narxlari, xonalariga HECH NARSA YOZMAYDI
 *
 * Har bir muloqot `SyncLog` ga yoziladi ("Sinxronizatsiya" jurnali).
 */

import { Prisma, type ReservationStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../lib/config.js";
import { hotelToday, addDays } from "../../lib/hotelTime.js";
import { toDateKey, fromDateKey, toNumber } from "../../lib/serialize.js";
import { ValidationError } from "../../lib/errors.js";
import { sanitizeForLog } from "../../lib/sanitize.js";
import { hasEncryptionKey } from "../../lib/encryption.js";
import { getMealPrice } from "../settings.js";
import { getFx, toUzs, uzsToUsd, type FxRate } from "../fx.js";
import {
  Beds24Error,
  activeConnection,
  getBeds24Channel,
  getCreditState,
} from "../beds24/client.js";
import { getBookings, getCalendar, getTokenDetails, type ExternalBooking } from "../beds24/api.js";
import { getExternalProperty, listMappings, mappingHealth, type MappingRow } from "./mapping.js";

// ============================================================
//  Jurnal
// ============================================================

export type LogAction =
  | "ping"
  | "poll_bookings"
  | "pull_rates"
  | "drift_check"
  | "webhook_received"
  | "fx_refresh"
  | "connect"
  | "disconnect";

export async function logSync(
  action: LogAction,
  status: "SUCCESS" | "FAILED" | "SKIPPED",
  opts: { request?: unknown; response?: unknown; errorMessage?: string; durationMs?: number; reservationId?: string } = {}
): Promise<void> {
  try {
    const channel = await getBeds24Channel();
    await prisma.syncLog.create({
      data: {
        channelId: channel.id,
        action,
        direction: "CHANNEL_TO_PMS",
        status,
        request: opts.request === undefined ? undefined : (sanitizeForLog(opts.request) as Prisma.InputJsonValue),
        response: opts.response === undefined ? undefined : (sanitizeForLog(opts.response) as Prisma.InputJsonValue),
        errorMessage: opts.errorMessage?.slice(0, 500),
        durationMs: opts.durationMs,
        reservationId: opts.reservationId,
      },
    });
  } catch (e) {
    console.warn(`[kanal] jurnalga yozilmadi: ${String(e).slice(0, 120)}`);
  }
}

async function touchState(key: "bookings_pull" | "rates_pull" | "drift_check"): Promise<void> {
  const channel = await getBeds24Channel();
  await prisma.syncState.upsert({
    where: { channelId_key: { channelId: channel.id, key } },
    create: { channelId: channel.id, key, lastSuccessfulAt: new Date() },
    update: { lastSuccessfulAt: new Date() },
  });
}

async function stateAt(key: string): Promise<string | null> {
  const row = await prisma.syncState.findFirst({ where: { key, channel: { code: "beds24" } } });
  return row?.lastSuccessfulAt?.toISOString() ?? null;
}

/** Ulanish bor-yo'qligini tekshirib, amalni jurnal bilan o'raydi */
async function withLog<T>(action: LogAction, fn: () => Promise<T>, summarize: (r: T) => unknown): Promise<T> {
  const conn = await activeConnection();
  if (!conn) throw new ValidationError("Beds24 ulanmagan — avval Channel manager → Ulangan kanallar'da ulang");

  const started = Date.now();
  try {
    const result = await fn();
    await logSync(action, "SUCCESS", { response: summarize(result), durationMs: Date.now() - started });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logSync(action, "FAILED", { errorMessage: msg, durationMs: Date.now() - started });
    // Faqat Beds24 xatosi ulanish holatini "xato" qiladi — "mapping yo'q"
    // kabi PMS tomondagi sabab ulanishga taalluqli emas
    if (e instanceof Beds24Error) {
      await prisma.channelConnection.update({
        where: { id: conn.id },
        data: { lastError: msg.slice(0, 300), lastCheckedAt: new Date(), lastCheckOk: false },
      }).catch(() => {});
      throw new ValidationError(msg);
    }
    throw e;
  }
}

// ============================================================
//  1. Ulanishni tekshirish
// ============================================================

export async function pingConnection() {
  const conn = await activeConnection();
  if (!conn) throw new ValidationError("Beds24 ulanmagan");

  const started = Date.now();
  try {
    const details = await getTokenDetails().catch(() => null);
    const prop = await getExternalProperty(true);
    const result = {
      ok: true,
      propertyId: prop.id,
      propertyName: prop.name,
      currency: prop.currency,
      roomTypes: prop.roomTypes.length,
      units: prop.roomTypes.reduce((n, rt) => n + rt.units.length, 0),
      scopes: details?.scopes ?? [],
      credits: getCreditState(),
    };
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { lastCheckedAt: new Date(), lastCheckOk: true, lastError: null, scopes: result.scopes },
    });
    await logSync("ping", "SUCCESS", { response: result, durationMs: Date.now() - started });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { lastCheckedAt: new Date(), lastCheckOk: false, lastError: msg.slice(0, 300) },
    });
    await logSync("ping", "FAILED", { errorMessage: msg, durationMs: Date.now() - started });
    return { ok: false, error: msg, credits: getCreditState() };
  }
}

// ============================================================
//  2. Bronlarni o'qish va PMS bilan solishtirish
// ============================================================

const ACTIVE_PMS: ReservationStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"];
/** `deleted` — Beds24 javobida endi yo'q (o'chirilgan); bron emas */
const INACTIVE_B24 = new Set(["cancelled", "black", "inquiry", "deleted"]);

type PmsRes = {
  id: string;
  roomId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  status: ReservationStatus;
  externalReference: string | null;
  guestName: string;
};

type Target = { roomId: string | null; roomTypeId: string | null; roomNumber: string | null };

export type MatchResult = { matchStatus: string; matchNote: string | null; reservationId: string | null };

const STATUS_UZ: Record<string, string> = {
  cancelled: "bekor qilingan",
  black: "yopish (black)",
  inquiry: "so'rov (inquiry)",
  deleted: "Beds24'dan o'chirilgan",
};

function resolveTarget(
  b: { externalRoomTypeId: string; externalUnitId: string | null },
  mappings: MappingRow[]
): Target | null {
  const unit = b.externalUnitId
    ? mappings.find((m) => m.level === "unit" && m.externalRoomTypeId === b.externalRoomTypeId && m.externalUnitId === b.externalUnitId)
    : undefined;
  if (unit) return { roomId: unit.roomId, roomTypeId: unit.roomTypeId, roomNumber: unit.roomNumber };
  const type = mappings.find((m) => m.level === "type" && m.externalRoomTypeId === b.externalRoomTypeId);
  if (type) return { roomId: null, roomTypeId: type.roomTypeId, roomNumber: null };
  return null;
}

function differences(b: SnapshotBooking, t: Target | null, r: PmsRes): string[] {
  const out: string[] = [];
  if (b.arrival !== r.checkIn || b.departure !== r.checkOut) {
    out.push(`sanalar: Beds24 ${b.arrival}–${b.departure}, PMS ${r.checkIn}–${r.checkOut}`);
  }
  if (t?.roomId && t.roomId !== r.roomId) out.push(`xona: Beds24 ${t.roomNumber ?? t.roomId}, PMS ${r.roomId}`);
  else if (t?.roomTypeId && !t.roomId && t.roomTypeId !== r.roomTypeId) out.push(`tarif: Beds24 ${t.roomTypeId}, PMS ${r.roomTypeId}`);
  if (b.numAdult !== r.adults) out.push(`kattalar: Beds24 ${b.numAdult}, PMS ${r.adults}`);
  return out;
}

type SnapshotBooking = {
  externalId: string;
  externalRoomTypeId: string;
  externalUnitId: string | null;
  status: string;
  arrival: string;
  departure: string;
  numAdult: number;
  apiReference: string | null;
};

/**
 * Beds24 bronlarini PMS bronlari bilan solishtiradi (faqat o'qiydi).
 *
 * Tartib: avval OTA raqami (`apiReference` = PMS `externalReference`)
 * bo'yicha aniq moslik, keyin xona/tarif + sanalar. Bitta PMS broni
 * ikki Beds24 broniga "mos" deb hisoblanmaydi.
 */
export function matchBookings(bookings: SnapshotBooking[], pms: PmsRes[], mappings: MappingRow[]): Map<string, MatchResult> {
  const out = new Map<string, MatchResult>();
  const used = new Set<string>();
  const isActive = (r: PmsRes) => ACTIVE_PMS.includes(r.status);

  // OTA raqami borlar birinchi — ular aniq
  const ordered = [...bookings].sort((a, b) => Number(!!b.apiReference) - Number(!!a.apiReference));

  for (const b of ordered) {
    const target = resolveTarget(b, mappings);
    const byRef = b.apiReference
      ? pms.find((r) => r.externalReference === b.apiReference && !used.has(r.id))
      : undefined;

    if (INACTIVE_B24.has(b.status)) {
      if (byRef && isActive(byRef)) {
        used.add(byRef.id);
        out.set(b.externalId, {
          matchStatus: "MISMATCH",
          matchNote: `Beds24'da ${STATUS_UZ[b.status] ?? b.status}, PMS'da hali faol`,
          reservationId: byRef.id,
        });
      } else {
        out.set(b.externalId, { matchStatus: "INACTIVE", matchNote: STATUS_UZ[b.status] ?? b.status, reservationId: byRef?.id ?? null });
      }
      continue;
    }

    if (byRef) {
      used.add(byRef.id);
      const diffs = differences(b, target, byRef);
      if (!isActive(byRef)) diffs.unshift(`PMS'da ${byRef.status === "NO_SHOW" ? "kelmadi" : "bekor qilingan"}, Beds24'da faol`);
      out.set(b.externalId, {
        matchStatus: diffs.length ? "MISMATCH" : "MATCHED",
        matchNote: diffs.join("; ") || null,
        reservationId: byRef.id,
      });
      continue;
    }

    if (!target) {
      out.set(b.externalId, {
        matchStatus: "UNMAPPED",
        matchNote: `Beds24 xonasi ${b.externalRoomTypeId}${b.externalUnitId ? "/" + b.externalUnitId : ""} PMS'ga bog'lanmagan`,
        reservationId: null,
      });
      continue;
    }

    const candidates = pms.filter((r) =>
      isActive(r) && !used.has(r.id) &&
      (target.roomId ? r.roomId === target.roomId : r.roomTypeId === target.roomTypeId)
    );
    const exact = candidates.find((r) => r.checkIn === b.arrival && r.checkOut === b.departure);
    if (exact) {
      used.add(exact.id);
      const diffs = differences(b, target, exact);
      const notes = [...diffs];
      if (b.apiReference && !exact.externalReference) notes.push(`OTA raqami (${b.apiReference}) PMS bronida kiritilmagan`);
      out.set(b.externalId, {
        matchStatus: diffs.length ? "MISMATCH" : "MATCHED",
        matchNote: notes.join("; ") || null,
        reservationId: exact.id,
      });
      continue;
    }

    const overlap = candidates.find((r) => r.checkIn < b.departure && r.checkOut > b.arrival);
    if (overlap) {
      used.add(overlap.id);
      out.set(b.externalId, {
        matchStatus: "MISMATCH",
        matchNote: differences(b, target, overlap).join("; ") || "sanalar kesishadi",
        reservationId: overlap.id,
      });
      continue;
    }

    out.set(b.externalId, {
      matchStatus: "MISSING_IN_PMS",
      matchNote: `PMS'da yo'q — ${target.roomNumber ? target.roomNumber + "-xona" : "tarif " + target.roomTypeId}, ${b.arrival}–${b.departure}`,
      reservationId: null,
    });
  }
  return out;
}

async function loadPmsReservations(refs: string[]): Promise<PmsRes[]> {
  const today = hotelToday();
  const rows = await prisma.reservation.findMany({
    where: {
      OR: [
        { checkOut: { gte: addDays(today, -1) } },
        ...(refs.length ? [{ externalReference: { in: refs } }] : []),
      ],
    },
    select: {
      id: true, roomId: true, checkIn: true, checkOut: true, adults: true, children: true,
      status: true, externalReference: true,
      room: { select: { roomTypeId: true } },
      guest: { select: { fullName: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    roomId: r.roomId,
    roomTypeId: r.room.roomTypeId,
    checkIn: toDateKey(r.checkIn) ?? "",
    checkOut: toDateKey(r.checkOut) ?? "",
    adults: r.adults,
    children: r.children,
    status: r.status,
    externalReference: r.externalReference,
    guestName: r.guest.fullName,
  }));
}

/**
 * Nusxadagi hamma bronni PMS'ning JORIY holati bilan qayta solishtiradi.
 *
 * Faqat baza — Beds24'ga so'rov yo'q, kredit sarflanmaydi. Ro'yxat va
 * xulosa ochilganda chaqiriladi: qabulxona bronni hozirgina kiritgan
 * bo'lsa, "PMS'da yo'q" darhol "mos" ga o'tadi.
 */
export async function rematchAll(): Promise<void> {
  const channel = await getBeds24Channel();
  const rows = await prisma.channelBooking.findMany({
    where: { channelId: channel.id, departure: { gte: addDays(hotelToday(), -1) } },
  });
  if (rows.length === 0) return;

  const snap: SnapshotBooking[] = rows.map((r) => ({
    externalId: r.externalId,
    externalRoomTypeId: r.externalRoomTypeId,
    externalUnitId: r.externalUnitId,
    status: r.status,
    arrival: toDateKey(r.arrival) ?? "",
    departure: toDateKey(r.departure) ?? "",
    numAdult: r.numAdult,
    apiReference: r.apiReference,
  }));
  const [pms, mappings] = await Promise.all([
    loadPmsReservations(snap.map((s) => s.apiReference).filter((x): x is string => !!x)),
    listMappings(),
  ]);
  const result = matchBookings(snap, pms, mappings);

  for (const r of rows) {
    const m = result.get(r.externalId);
    if (!m) continue;
    if (m.matchStatus !== r.matchStatus || m.matchNote !== r.matchNote || m.reservationId !== r.reservationId) {
      await prisma.channelBooking.update({ where: { id: r.id }, data: m });
    }
  }
}

/** Beds24 bronini nusxaga yozadi (webhook va polling uchun umumiy) */
export async function upsertSnapshot(b: ExternalBooking, currency: string): Promise<void> {
  const channel = await getBeds24Channel();
  const data = {
    externalRoomTypeId: b.externalRoomTypeId,
    externalUnitId: b.externalUnitId,
    status: b.status,
    subStatus: b.subStatus,
    arrival: fromDateKey(b.arrival),
    departure: fromDateKey(b.departure),
    numAdult: b.numAdult,
    numChild: b.numChild,
    price: new Prisma.Decimal(b.price.toFixed(2)),
    currency,
    guestName: b.guestName.slice(0, 200),
    phone: b.phone,
    email: b.email,
    country: b.country,
    source: b.source,
    apiReference: b.apiReference,
    notes: b.notes,
    bookedAt: b.bookedAt,
    modifiedAt: b.modifiedAt,
    lastSeenAt: new Date(),
  };
  await prisma.channelBooking.upsert({
    where: { channelId_externalId: { channelId: channel.id, externalId: b.externalId } },
    create: { channelId: channel.id, externalId: b.externalId, ...data },
    update: data,
  });
}

export type PollResult = {
  fetched: number;
  active: number;
  matched: number;
  mismatch: number;
  missingInPms: number;
  unmapped: number;
  inactive: number;
  deletedInBeds24: number;
};

/** "Hoziroq tekshirish": Beds24 bronlarini o'qiydi va PMS bilan solishtiradi */
export async function pollBookings(): Promise<PollResult> {
  return withLog("poll_bookings", async () => {
    const conn = (await activeConnection())!;
    const prop = await getExternalProperty();
    const today = toDateKey(hotelToday())!;
    const started = new Date();
    const bookings = await getBookings(conn.propertyId, today);

    for (const b of bookings) await upsertSnapshot(b, prop.currency);

    // Javobda yo'q bo'lib qolgan (Beds24'da o'chirilgan) hozirgi/kelgusi
    // bronlar — aks holda ular "PMS'da yo'q" deb yolg'on signal berardi.
    // So'rov hamma statusni oladi, ya'ni bekor qilinganlar ham keladi
    const gone = await prisma.channelBooking.updateMany({
      where: {
        channel: { code: "beds24" },
        departure: { gte: fromDateKey(today) },
        lastSeenAt: { lt: started },
        NOT: { status: "deleted" },
      },
      data: { status: "deleted" },
    });
    await rematchAll();
    await touchState("bookings_pull");

    const channel = await getBeds24Channel();
    const ids = bookings.map((b) => b.externalId);
    const rows = await prisma.channelBooking.findMany({
      where: { channelId: channel.id, externalId: { in: ids } },
      select: { matchStatus: true },
    });
    const count = (s: string) => rows.filter((r) => r.matchStatus === s).length;
    return {
      fetched: bookings.length,
      active: rows.length - count("INACTIVE"),
      matched: count("MATCHED"),
      mismatch: count("MISMATCH"),
      missingInPms: count("MISSING_IN_PMS"),
      unmapped: count("UNMAPPED"),
      inactive: count("INACTIVE"),
      deletedInBeds24: gone.count,
    };
  }, (r) => r);
}

// ============================================================
//  3. Kalendar (bo'sh joy, narx)
// ============================================================

export async function pullRates(days = config.beds24.horizonDays): Promise<{ days: number; rows: number; roomTypes: number }> {
  return withLog("pull_rates", async () => {
    const conn = (await activeConnection())!;
    const channel = await getBeds24Channel();
    const from = hotelToday();
    const start = toDateKey(from)!;
    const end = toDateKey(addDays(from, days - 1))!;
    const cal = await getCalendar(conn.propertyId, start, end);

    await prisma.$transaction([
      prisma.channelCalendar.deleteMany({ where: { channelId: channel.id, date: { gte: from, lte: fromDateKey(end) } } }),
      prisma.channelCalendar.createMany({
        data: cal.map((c) => ({
          channelId: channel.id,
          externalRoomTypeId: c.externalRoomTypeId,
          date: fromDateKey(c.date),
          numAvail: c.numAvail,
          price1: c.price1 === null ? null : new Prisma.Decimal(c.price1.toFixed(2)),
          minStay: c.minStay,
        })),
        skipDuplicates: true,
      }),
    ]);
    await touchState("rates_pull");
    return { days, rows: cal.length, roomTypes: new Set(cal.map((c) => c.externalRoomTypeId)).size };
  }, (r) => r);
}

// ============================================================
//  4. Farqni tekshirish (drift)
// ============================================================

export type DriftIssue = {
  kind: "OVERSELL_RISK" | "UNDERSELL" | "PRICE_DIFF" | "PRICE_MISSING";
  externalRoomTypeId: string;
  label: string;
  date: string;
  beds24: number | null;
  pms: number | null;
  note: string;
};

/** Tarif narxlari so'mda: [roomTypeId|date] -> narx */
async function pmsPrices(typeIds: string[], from: Date, toEx: Date): Promise<Map<string, number>> {
  const rows = await prisma.ratePlan.findMany({
    where: { roomTypeId: { in: typeIds }, date: { gte: from, lt: toEx } },
    select: { roomTypeId: true, date: true, price: true },
  });
  return new Map(rows.map((r) => [`${r.roomTypeId}|${toDateKey(r.date)}`, toNumber(r.price)]));
}

/** Xona x kun bandligi (faol bron yoki yopiq kun) */
async function pmsBusy(roomIds: string[], from: Date, toEx: Date): Promise<Set<string>> {
  const busy = new Set<string>();
  const [res, blocks] = await Promise.all([
    prisma.reservation.findMany({
      where: { roomId: { in: roomIds }, status: { in: ACTIVE_PMS }, checkIn: { lt: toEx }, checkOut: { gt: from } },
      select: { roomId: true, checkIn: true, checkOut: true },
    }),
    prisma.roomDayStatus.findMany({
      where: { roomId: { in: roomIds }, isBlocked: true, date: { gte: from, lt: toEx } },
      select: { roomId: true, date: true },
    }),
  ]);
  for (const r of res) {
    // Chiqib ketgan mehmon xonasi chiqish kunidan boshlab bo'sh — [) qoidasi
    for (let d = new Date(Math.max(r.checkIn.getTime(), from.getTime())); d < r.checkOut && d < toEx; d = addDays(d, 1)) {
      busy.add(`${r.roomId}|${toDateKey(d)}`);
    }
  }
  for (const b of blocks) busy.add(`${b.roomId}|${toDateKey(b.date)}`);
  return busy;
}

type Group = { externalRoomTypeId: string; label: string; roomIds: string[]; priceTypeId: string | null; includesMeal: boolean; maxAdults: number };

/** Beds24 xona turi -> PMS xonalari to'plami (bo'sh joy va narx solishtirish uchun) */
async function buildGroups(mappings: MappingRow[]): Promise<Group[]> {
  const rooms = await prisma.room.findMany({ where: { isActive: true }, select: { id: true, roomTypeId: true } });
  const types = await prisma.roomType.findMany({ select: { id: true, maxAdults: true, label: true } });
  const ext = [...new Set(mappings.map((m) => m.externalRoomTypeId))];

  return ext.map((rt) => {
    const ms = mappings.filter((m) => m.externalRoomTypeId === rt);
    const unitRooms = ms.filter((m) => m.level === "unit" && m.roomId).map((m) => m.roomId!);
    const typeMap = ms.find((m) => m.level === "type");
    const roomIds = unitRooms.length
      ? unitRooms
      : rooms.filter((r) => r.roomTypeId === typeMap?.roomTypeId).map((r) => r.id);
    const typeIds = [...new Set(unitRooms.length ? rooms.filter((r) => unitRooms.includes(r.id)).map((r) => r.roomTypeId) : [typeMap?.roomTypeId])];
    const priceTypeId = typeIds.length === 1 ? typeIds[0] ?? null : null;
    const name = ms.find((m) => m.externalName)?.externalName?.split(" / ")[0];
    return {
      externalRoomTypeId: rt,
      label: name ? `${name} (#${rt})` : `#${rt}`,
      roomIds,
      priceTypeId,
      includesMeal: ms.some((m) => m.includesMeal),
      maxAdults: types.find((t) => t.id === priceTypeId)?.maxAdults ?? 2,
    };
  });
}

/** Narx farqi foizda shu chegaradan kichik bo'lsa "mos" (kurs yaxlitlanishi) */
const PRICE_TOLERANCE = 0.02;

export async function driftCheck() {
  return withLog("drift_check", async () => {
    const channel = await getBeds24Channel();
    const mappings = await listMappings();
    if (mappings.length === 0) throw new ValidationError("Bog'lanish (mapping) yo'q — solishtirib bo'lmaydi");

    const from = hotelToday();
    const toEx = addDays(from, config.beds24.horizonDays);
    const [groups, fx, meal, cal] = await Promise.all([
      buildGroups(mappings),
      getFx(),
      getMealPrice(),
      prisma.channelCalendar.findMany({ where: { channelId: channel.id, date: { gte: from, lt: toEx } } }),
    ]);
    if (cal.length === 0) throw new ValidationError("Beds24 kalendari hali o'qilmagan — avval narxlarni o'qing");

    const prop = await getExternalProperty().catch(() => null);
    const currency = prop?.currency ?? "USD";
    const busy = await pmsBusy(groups.flatMap((g) => g.roomIds), from, toEx);
    const prices = await pmsPrices(groups.map((g) => g.priceTypeId).filter((x): x is string => !!x), from, toEx);

    const issues: DriftIssue[] = [];
    let compared = 0;
    const unitNotes: string[] = [];

    for (const g of groups) {
      const qty = prop?.roomTypes.find((r) => r.id === g.externalRoomTypeId)?.qty;
      if (qty !== undefined && qty !== g.roomIds.length) {
        unitNotes.push(`${g.label}: Beds24'da ${qty} ta xona, PMS'da ${g.roomIds.length} ta bog'langan`);
      }
      for (const c of cal.filter((x) => x.externalRoomTypeId === g.externalRoomTypeId)) {
        const date = toDateKey(c.date)!;
        compared++;
        const pmsFree = g.roomIds.filter((id) => !busy.has(`${id}|${date}`)).length;

        if (c.numAvail !== null && c.numAvail > pmsFree) {
          issues.push({
            kind: "OVERSELL_RISK", externalRoomTypeId: g.externalRoomTypeId, label: g.label, date,
            beds24: c.numAvail, pms: pmsFree,
            note: `Beds24 ${c.numAvail} ta bo'sh deb sotmoqda, PMS'da ${pmsFree} ta bo'sh — ikki marta sotilishi mumkin`,
          });
        } else if (c.numAvail !== null && c.numAvail < pmsFree) {
          issues.push({
            kind: "UNDERSELL", externalRoomTypeId: g.externalRoomTypeId, label: g.label, date,
            beds24: c.numAvail, pms: pmsFree,
            note: `Beds24'da ${c.numAvail} ta, PMS'da ${pmsFree} ta bo'sh — OTA'da kamroq sotilmoqda`,
          });
        }

        if (!g.priceTypeId) continue;
        const pmsPrice = prices.get(`${g.priceTypeId}|${date}`);
        if (pmsPrice === undefined) continue;
        const comparable = pmsPrice + (g.includesMeal ? meal * g.maxAdults : 0);
        const b24 = c.price1 === null ? null : toNumber(c.price1);

        if (!b24) {
          issues.push({
            kind: "PRICE_MISSING", externalRoomTypeId: g.externalRoomTypeId, label: g.label, date,
            beds24: null, pms: comparable,
            note: "Beds24'da narx yo'q — OTA'da bu kun yopiq",
          });
          continue;
        }
        const b24Uzs = toUzs(b24, currency, fx);
        if (b24Uzs === null) continue;   // kurs noma'lum — solishtirib bo'lmaydi
        const diff = Math.abs(b24Uzs - comparable) / comparable;
        if (diff > PRICE_TOLERANCE) {
          issues.push({
            kind: "PRICE_DIFF", externalRoomTypeId: g.externalRoomTypeId, label: g.label, date,
            beds24: b24Uzs, pms: comparable,
            note: `Beds24 ${b24} ${currency} ≈ ${Math.round(b24Uzs).toLocaleString("ru-RU")} so'm, PMS ${Math.round(comparable).toLocaleString("ru-RU")} so'm (${Math.round(diff * 100)}%)`,
          });
        }
      }
    }

    await touchState("drift_check");
    const count = (k: DriftIssue["kind"]) => issues.filter((i) => i.kind === k).length;
    return {
      checkedAt: new Date().toISOString(),
      horizonDays: config.beds24.horizonDays,
      compared,
      fx: fx ? { rate: fx.rate, date: fx.date } : null,
      currency,
      oversellRisk: count("OVERSELL_RISK"),
      undersell: count("UNDERSELL"),
      priceDiff: count("PRICE_DIFF"),
      priceMissing: count("PRICE_MISSING"),
      notes: unitNotes,
      issues: issues.slice(0, 400),
    };
  }, (r) => r);
}

/** Oxirgi drift natijasi — jurnaldan (Beds24'ga so'rovsiz) */
export async function lastDrift() {
  const row = await prisma.syncLog.findFirst({
    where: { action: "drift_check", status: "SUCCESS", channel: { code: "beds24" } },
    orderBy: { createdAt: "desc" },
  });
  return (row?.response as Awaited<ReturnType<typeof driftCheck>> | null) ?? null;
}

/** Davriy vazifa: bronlar + kalendar + farq. Ulanish bo'lmasa jim */
export async function runMonitor(): Promise<{ skipped: boolean } | { poll: PollResult | null; drift: boolean }> {
  if (!(await activeConnection())) return { skipped: true };
  const poll = await pollBookings().catch(() => null);
  await pullRates().catch(() => null);
  const drift = await driftCheck().then(() => true).catch(() => false);
  return { poll, drift };
}

// ============================================================
//  5. Founder uchun ko'rinishlar (faqat baza)
// ============================================================

export async function connectionStatus() {
  const conn = await activeConnection();
  return {
    connected: !!conn,
    propertyId: conn?.propertyId ?? null,
    tokenExpiresAt: conn?.accessTokenExpiresAt?.toISOString() ?? null,
    lastCheckedAt: conn?.lastCheckedAt?.toISOString() ?? null,
    lastCheckOk: conn?.lastCheckOk ?? null,
    lastError: conn?.lastError ?? null,
    scopes: (conn?.scopes as string[] | null) ?? [],
    connectedAt: conn?.createdAt.toISOString() ?? null,
    credits: getCreditState(),
    encryptionKeySet: hasEncryptionKey(),
    webhookConfigured: !!config.beds24.webhookUrlToken,
    monitorMinutes: config.beds24.monitorMinutes,
    horizonDays: config.beds24.horizonDays,
    baseUrl: config.beds24.baseUrl,
    mode: "read-only" as const,
  };
}

export async function channelSummary() {
  await rematchAll();
  const channel = await getBeds24Channel();
  const today = hotelToday();
  const [status, health, byMatch, lastPoll, lastRates, drift, fx, webhooks24h, missing, mismatched] = await Promise.all([
    connectionStatus(),
    mappingHealth(),
    prisma.channelBooking.groupBy({
      by: ["matchStatus"],
      where: { channelId: channel.id, departure: { gte: today } },
      _count: { _all: true },
    }),
    stateAt("bookings_pull"),
    stateAt("rates_pull"),
    lastDrift(),
    getFx(),
    prisma.webhookEvent.count({ where: { channelId: channel.id, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.channelBooking.findMany({
      where: { channelId: channel.id, matchStatus: "MISSING_IN_PMS", departure: { gte: today } },
      orderBy: { arrival: "asc" },
      take: 10,
    }),
    prisma.channelBooking.count({ where: { channelId: channel.id, matchStatus: "MISMATCH", departure: { gte: today } } }),
  ]);
  const counts = Object.fromEntries(byMatch.map((r) => [r.matchStatus, r._count._all]));
  const failed24h = await prisma.syncLog.count({
    where: { channelId: channel.id, status: "FAILED", createdAt: { gte: new Date(Date.now() - 86_400_000) } },
  });

  return {
    connection: status,
    mapping: health,
    bookings: {
      lastPollAt: lastPoll,
      matched: counts.MATCHED ?? 0,
      mismatch: mismatched,
      missingInPms: counts.MISSING_IN_PMS ?? 0,
      unmapped: counts.UNMAPPED ?? 0,
      inactive: counts.INACTIVE ?? 0,
      activeTotal: (counts.MATCHED ?? 0) + mismatched + (counts.MISSING_IN_PMS ?? 0) + (counts.UNMAPPED ?? 0),
      missing: missing.map(serializeChannelBooking),
    },
    rates: { lastPulledAt: lastRates },
    drift: drift
      ? {
          checkedAt: drift.checkedAt,
          oversellRisk: drift.oversellRisk,
          undersell: drift.undersell,
          priceDiff: drift.priceDiff,
          priceMissing: drift.priceMissing,
          notes: drift.notes,
        }
      : null,
    webhooks24h,
    failed24h,
    fx,
  };
}

export function serializeChannelBooking(b: Prisma.ChannelBookingGetPayload<object>) {
  return {
    id: b.id,
    externalId: b.externalId,
    externalRoomTypeId: b.externalRoomTypeId,
    externalUnitId: b.externalUnitId,
    status: b.status,
    subStatus: b.subStatus,
    arrival: toDateKey(b.arrival),
    departure: toDateKey(b.departure),
    numAdult: b.numAdult,
    numChild: b.numChild,
    price: toNumber(b.price),
    currency: b.currency,
    guestName: b.guestName,
    phone: b.phone,
    email: b.email,
    country: b.country,
    source: b.source,
    apiReference: b.apiReference,
    notes: b.notes,
    bookedAt: b.bookedAt?.toISOString() ?? null,
    modifiedAt: b.modifiedAt?.toISOString() ?? null,
    matchStatus: b.matchStatus,
    matchNote: b.matchNote,
    reservationId: b.reservationId,
    lastSeenAt: b.lastSeenAt.toISOString(),
  };
}

export async function listChannelBookings(opts: { match?: string; includePast?: boolean; limit?: number }) {
  await rematchAll();
  const channel = await getBeds24Channel();
  const rows = await prisma.channelBooking.findMany({
    where: {
      channelId: channel.id,
      ...(opts.match ? { matchStatus: opts.match } : {}),
      ...(opts.includePast ? {} : { departure: { gte: hotelToday() } }),
    },
    orderBy: { arrival: "asc" },
    take: Math.min(opts.limit ?? 200, 1000),
  });
  const fx = await getFx();
  return rows.map((r) => {
    const s = serializeChannelBooking(r);
    return { ...s, priceUzs: toUzs(s.price, s.currency, fx) };
  });
}

/** Shaxmatka bron oynasi: shu PMS broniga mos Beds24 broni */
export async function reservationChannelInfo(reservationId: string) {
  await rematchAll();
  const row = await prisma.channelBooking.findFirst({
    where: { reservationId, channel: { code: "beds24" } },
    orderBy: { lastSeenAt: "desc" },
  });
  const fx = await getFx();
  if (!row) return { found: false as const, fx };
  const s = serializeChannelBooking(row);
  return { found: true as const, booking: { ...s, priceUzs: toUzs(s.price, s.currency, fx) }, fx };
}

// ============================================================
//  6. Narxlar sahifasi — PMS narxi, $ va Beds24 narxi yonma-yon
// ============================================================

export type RateCell = {
  pms: number | null;
  usd: number | null;
  beds24: number | null;
  beds24Uzs: number | null;
  beds24Avail: number | null;
  /** ok — mos; diff — farq; closed — Beds24'da narx yo'q; none — solishtirib bo'lmaydi */
  status: "ok" | "diff" | "closed" | "none";
};

export async function ratesComparison(fromKey: string, toKey: string) {
  const from = fromDateKey(fromKey);
  const toEx = addDays(fromDateKey(toKey), 1);
  if (toEx <= from) throw new ValidationError("to >= from bo'lishi kerak");
  if ((toEx.getTime() - from.getTime()) / 86_400_000 > 120) throw new ValidationError("Oraliq ko'pi bilan 120 kun");

  const channel = await getBeds24Channel();
  const [types, mappings, fx, meal, rates, cal, lastPulled] = await Promise.all([
    prisma.roomType.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, label: true, maxAdults: true } }),
    listMappings(),
    getFx(),
    getMealPrice(),
    prisma.ratePlan.findMany({ where: { date: { gte: from, lt: toEx } }, select: { roomTypeId: true, date: true, price: true } }),
    prisma.channelCalendar.findMany({ where: { channelId: channel.id, date: { gte: from, lt: toEx } } }),
    stateAt("rates_pull"),
  ]);
  const rooms = await prisma.room.findMany({ select: { id: true, roomTypeId: true } });
  const conn = await activeConnection();
  const prop = conn ? await getExternalProperty().catch(() => null) : null;
  const currency = prop?.currency ?? "USD";

  const pmsPrice = new Map(rates.map((r) => [`${r.roomTypeId}|${toDateKey(r.date)}`, toNumber(r.price)]));
  const calMap = new Map(cal.map((c) => [`${c.externalRoomTypeId}|${toDateKey(c.date)}`, c]));

  const out = types.map((t) => {
    const typeRooms = rooms.filter((r) => r.roomTypeId === t.id).map((r) => r.id);
    const ms = mappings.filter((m) => m.roomTypeId === t.id || (m.roomId && typeRooms.includes(m.roomId)));
    const ext = [...new Map(ms.map((m) => [m.externalRoomTypeId, m])).values()];
    const primary = ext.find((m) => m.level === "type") ?? ext[0];

    const days: Record<string, RateCell> = {};
    for (let d = from; d < toEx; d = addDays(d, 1)) {
      const key = toDateKey(d)!;
      const pms = pmsPrice.get(`${t.id}|${key}`) ?? null;
      const c = primary ? calMap.get(`${primary.externalRoomTypeId}|${key}`) : undefined;
      const b24 = c?.price1 === null || c?.price1 === undefined ? null : toNumber(c.price1);
      const b24Uzs = b24 === null ? null : toUzs(b24, currency, fx);

      let status: RateCell["status"] = "none";
      if (primary && c) {
        if (!b24) status = "closed";
        else if (pms !== null && b24Uzs !== null) {
          const comparable = pms + (primary.includesMeal ? meal * t.maxAdults : 0);
          status = Math.abs(b24Uzs - comparable) / comparable <= PRICE_TOLERANCE ? "ok" : "diff";
        }
      }
      days[key] = {
        pms,
        usd: pms === null ? null : uzsToUsd(pms, fx),
        beds24: b24,
        beds24Uzs: b24Uzs,
        beds24Avail: c?.numAvail ?? null,
        status,
      };
    }

    return {
      roomTypeId: t.id,
      label: t.label,
      beds24: ext.map((m) => ({
        externalRoomTypeId: m.externalRoomTypeId,
        name: (m.externalName ?? "").split(" / ")[0] || `#${m.externalRoomTypeId}`,
        level: m.level,
        includesMeal: m.includesMeal,
      })),
      days,
    };
  });

  return { from: fromKey, to: toKey, currency, fx: fx as FxRate | null, lastPulledAt: lastPulled, types: out };
}

// ============================================================
//  7. Jurnallar
// ============================================================

export async function listSyncLog(opts: { limit?: number; action?: string; status?: string }) {
  const rows = await prisma.syncLog.findMany({
    where: {
      channel: { code: "beds24" },
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.status ? { status: opts.status as "SUCCESS" | "FAILED" | "SKIPPED" | "RETRYING" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 500),
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    direction: r.direction,
    status: r.status,
    errorMessage: r.errorMessage,
    durationMs: r.durationMs,
    response: r.response,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listWebhookEvents(opts: { limit?: number; status?: string }) {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      channel: { code: "beds24" },
      ...(opts.status ? { status: opts.status as "RECEIVED" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 500),
  });
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    externalId: r.externalId,
    status: r.status,
    errorMessage: r.errorMessage,
    processedAt: r.processedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    payload: r.rawPayload,
  }));
}

export async function webhookStats() {
  const rows = await prisma.webhookEvent.groupBy({
    by: ["status"],
    where: { channel: { code: "beds24" } },
    _count: { _all: true },
  });
  const last = await prisma.webhookEvent.findFirst({ where: { channel: { code: "beds24" } }, orderBy: { createdAt: "desc" } });
  return {
    total: rows.reduce((n, r) => n + r._count._all, 0),
    byStatus: Object.fromEntries(rows.map((r) => [r.status, r._count._all])),
    lastAt: last?.createdAt.toISOString() ?? null,
    configured: !!config.beds24.webhookUrlToken,
  };
}
