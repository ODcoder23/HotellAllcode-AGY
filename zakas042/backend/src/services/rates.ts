/**
 * Narx va cheklovlar sinxronizatsiyasi — TZ 9, 10-band
 *
 * Cheklovlar (2026-09-27): minStay, maxStay, kirish/chiqish taqiqi
 * (`RatePlan`). null — PMS boshqarmaydi: yuborilmaydi, Beds24'dagisi
 * buzilmaydi. Narx bilan bitta so'rovda ketadi va bitta `syncedAt`.
 *
 * Mijoz qarori Q8: avtomatik o'suvchi narx YO'Q, admin qo'lda belgilaydi.
 * Q9 ("Beds24 ustuvor"): Shaxmatka/admin panel — Beds24'ni boshqarish
 * oynasi. Ikki yo'nalish:
 *
 *   PMS -> Beds24   `pushRates`: admin o'zgartirgan (yuborilmagan) narx
 *                   so'm / bugungi kurs = $ bo'lib yuboriladi
 *   Beds24 -> PMS   `pullRates` (soatlik): Beds24 panelida o'zgargan narx
 *                   PMS'ga tortiladi. Yuborilmagan PMS narxi ustiga
 *                   YOZILMAYDI — u avval Beds24'ga ketadi
 *
 * HALQA HIMOYASI: biz yuborgan narx (`channelPrice`) qaytsa — o'zgarish
 * emas; kurs o'zgargan bo'lsa ham so'm narx buzilmaydi.
 *
 * IKKI XIL "NARX" — chalkashtirmaslik kerak:
 *   `Reservation.pricePerNight` — faqat shu bron (reservationSync.ts)
 *   `RatePlan.price` — butun tarif, kelajak bronlar (shu fayl)
 *
 * 2026-09-27: Beds24'ga bog'lanmagan tarif narxi yuborilmaydi va xato
 * ham yozilmaydi (ilgari har o'zgarishda FAILED + dead-letter bo'lardi).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { toDateKey, fromDateKey, toNumber } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import { logPush, logPull } from "../lib/syncLog.js";
import { BASE_CURRENCY, isBaseCurrency, round2, toCents } from "../lib/money.js";
import { findRoomTypeMapping } from "./mapping.js";
import { getChannel } from "./channel/registry.js";
import { activeConnection } from "./beds24/auth.js";
import { rateFor } from "./exchangeRate.js";
import { notifyRateSync } from "../realtime/notify.js";
import { rateSyncQueue, enqueueWithTimeout } from "../queues/index.js";
import type { DayRestrictions, ExternalRateDay } from "./channel/types.js";

/** Debounce oynasi — bir necha o'zgarish bitta yuborishga birlashadi */
const DEBOUNCE_MS = 3000;

export type RatePushOutcome =
  | { status: "sent"; roomTypeId: string; days: number }
  | { status: "skipped"; roomTypeId: string; reason: string }
  | { status: "failed"; roomTypeId: string; error: string; retryable: boolean };

// ============================================================
//  Valyuta
// ============================================================

export type ChannelConversion =
  | { ok: true; currency: string; rate: number }
  | { ok: false; error: string };

/**
 * PMS narxi (so'm) <-> Beds24 narxi (obyekt valyutasi) koeffitsienti.
 *
 * Beds24 obyekti USD: 600 000 so'm / 11 830.87 = $50.72. Kurs yoki Beds24
 * valyutasi noma'lum bo'lsa — yuborilmaydi (taxminiy narx bilan
 * sotgandan ko'ra kutgan yaxshi).
 */
export async function channelConversion(): Promise<ChannelConversion> {
  let currency: string;
  try {
    currency = (await getChannel().getCurrency()).toUpperCase();
  } catch (e) {
    return { ok: false, error: `Beds24 valyutasi aniqlanmadi: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
  }
  if (!currency || isBaseCurrency(currency)) return { ok: true, currency: currency || BASE_CURRENCY, rate: 1 };
  const rate = await rateFor(currency);
  if (!rate) return { ok: false, error: `${currency} kursi noma'lum (Markaziy bank javob bermadi)` };
  return { ok: true, currency, rate };
}

/** So'm narx -> Beds24 narxi (sentgacha) */
export function toChannelPrice(price: number, rate: number): number {
  return rate === 1 ? round2(price) : round2(price / rate);
}

/** Beds24 narxi -> so'm narx (butun so'm) */
export function fromChannelPrice(price: number, rate: number): number {
  return rate === 1 ? round2(price) : Math.round(price * rate);
}

/** Jurnal uchun: 3 tagacha turli narx ro'yxat, ko'p bo'lsa "min–max" */
function priceSummary(prices: number[]): string[] {
  const uniq = [...new Set(prices)].sort((a, b) => a - b);
  if (uniq.length <= 3) return uniq.map(String);
  return [`${uniq[0]}–${uniq[uniq.length - 1]}`];
}

/** Beds24'dagi narx shu PMS qatoriga tegishlimi (biz yuborganmi) */
function sameChannelPrice(
  row: { price: Prisma.Decimal; channelPrice: Prisma.Decimal | null },
  remote: number,
  rate: number
): boolean {
  const ours = row.channelPrice !== null ? toNumber(row.channelPrice) : toChannelPrice(toNumber(row.price), rate);
  return toCents(ours) === toCents(remote);
}

/**
 * Tarif narxi Beds24'ning qaysi xona turlariga yoziladi.
 *
 * Ikki xil Beds24 sozlamasi:
 *   - Beds24 turi = PMS tarifi (qty bilan): tur bog'lanishi
 *   - Beds24'da har "Room" = bitta xona (real hisob: Room 1 = 101):
 *     tarif narxi shu tarifning HAR bog'langan xonasining Beds24 turiga
 * Takrorlar olib tashlanadi — bir turga bir marta yoziladi.
 */
export async function rateTargets(roomTypeId: string): Promise<string[]> {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" }, select: { id: true } });
  if (!channel) return [];
  const [typeMap, roomMaps] = await Promise.all([
    findRoomTypeMapping(roomTypeId),
    prisma.channelMapping.findMany({
      where: { channelId: channel.id, isActive: true, roomId: { not: null }, room: { roomTypeId, isActive: true } },
      select: { externalRoomTypeId: true },
    }),
  ]);
  const out = new Set<string>();
  if (typeMap?.externalRoomTypeId) out.add(typeMap.externalRoomTypeId);
  for (const m of roomMaps) out.add(m.externalRoomTypeId);
  return [...out];
}

// ============================================================
//  1. PMS -> Beds24
// ============================================================

async function markRateError(roomTypeId: string, from: Date, to: Date, error: string): Promise<void> {
  await prisma.ratePlan.updateMany({
    where: { roomTypeId, date: { gte: from, lte: to }, syncedAt: null },
    data: { syncError: error.slice(0, 300) },
  });
}

/** PMS qatoridagi cheklovlar -> kanalga yuboriladigani (null — yuborilmaydi) */
export function restrictionsForPush(r: {
  minStay: number | null; maxStay: number | null;
  closedArrival: boolean | null; closedDeparture: boolean | null;
}): DayRestrictions {
  return {
    ...(r.minStay !== null ? { minStay: r.minStay } : {}),
    // 0 — cheklovsiz: Beds24'da maydon olib tashlanadi
    ...(r.maxStay !== null ? { maxStay: r.maxStay > 0 ? r.maxStay : null } : {}),
    ...(r.closedArrival !== null || r.closedDeparture !== null
      ? { closedArrival: r.closedArrival === true, closedDeparture: r.closedDeparture === true }
      : {}),
  };
}

/** Jurnal va panel uchun qisqa matn: "kamida 2 · ko'pi bilan 7 · kirish yo'q" */
export function restrictionText(r: DayRestrictions): string {
  return [
    r.minStay && r.minStay > 1 ? `kamida ${r.minStay}` : null,
    r.maxStay ? `ko'pi bilan ${r.maxStay}` : null,
    r.closedArrival ? "kirish yo'q" : null,
    r.closedDeparture ? "chiqish yo'q" : null,
  ].filter(Boolean).join(" · ");
}

/**
 * Bir tarif narx va cheklovlarini Beds24'ga yuboradi — `[from, to]`
 * (ikkalasi kiradi).
 *
 * Faqat `syncedAt = null` kunlar yuboriladi — yuborilgani qayta ketmaydi
 * (kredit tejash). Cheklov faqat PMS boshqarsa (null emas) yuboriladi —
 * aks holda Beds24'dagi "kamida 3 kecha" jimgina bosilib ketardi.
 */
export async function pushRates(roomTypeId: string, from: Date, to: Date): Promise<RatePushOutcome> {
  const started = Date.now();

  if (!(await activeConnection())) return { status: "skipped", roomTypeId, reason: "Beds24 ulanmagan" };

  const targets = await rateTargets(roomTypeId);
  if (targets.length === 0) return { status: "skipped", roomTypeId, reason: "tarif Beds24'ga bog'lanmagan" };

  // O'tgan kunlar yuborilmaydi — Beds24 ularni sotmaydi
  const start = from < hotelToday() ? hotelToday() : from;
  if (to < start) return { status: "skipped", roomTypeId, reason: "oraliq o'tmishda" };

  const pending = await prisma.ratePlan.findMany({
    where: { roomTypeId, date: { gte: start, lte: to }, syncedAt: null },
    orderBy: { date: "asc" },
  });
  if (pending.length === 0) return { status: "skipped", roomTypeId, reason: "o'zgarish yo'q" };

  const conv = await channelConversion();
  if (!conv.ok) {
    await markRateError(roomTypeId, start, to, conv.error);
    await logPush("push_rates", "FAILED", { request: { roomTypeId }, errorMessage: conv.error });
    return { status: "failed", roomTypeId, error: conv.error, retryable: true };
  }

  const days = pending.map((d) => ({
    date: toDateKey(d.date) ?? "",
    price: toChannelPrice(toNumber(d.price), conv.rate),
    ...restrictionsForPush(d),
  }));
  // Jurnal uchun (TZ 16-band: sana va qiymat)
  const restrictions = [...new Set(days.map((d) => restrictionText(d)))].filter(Boolean);
  const logInfo = {
    from: days[0]?.date, to: days[days.length - 1]?.date, days: days.length,
    prices: priceSummary(days.map((d) => d.price)), currency: conv.currency,
    ...(restrictions.length ? { restrictions: restrictions.length === 1 ? restrictions[0] : "turli cheklovlar" } : {}),
  };

  let detail = "";
  for (const externalRoomTypeId of targets) {
    const r = await getChannel().pushRates({ externalRoomTypeId, days });
    if (!r.ok) {
      const error = `${externalRoomTypeId}: ${r.error}`;
      await markRateError(roomTypeId, start, to, error);
      await logPush("push_rates", "FAILED", {
        request: { roomTypeId, externalRoomTypeId, ...logInfo },
        errorMessage: error,
        durationMs: Date.now() - started,
      });
      for (const d of days) notifyRateSync(roomTypeId, d.date, "error");
      return { status: "failed", roomTypeId, error, retryable: r.retryable };
    }
    detail = [detail, `${externalRoomTypeId}: ${r.detail ?? "ok"}`].filter(Boolean).join("; ");
  }

  // Faqat HAQIQATAN yuborilgan (sana, narx, cheklovlar) belgilanadi:
  // yuborish davomida admin narx yoki cheklovni yana o'zgartirgan bo'lsa
  // u kun "kutmoqda" qoladi
  const groups = new Map<string, { sent: (typeof pending)[number]; dates: Date[] }>();
  for (const d of pending) {
    const key = [toNumber(d.price).toFixed(2), d.minStay, d.maxStay, d.closedArrival, d.closedDeparture].join("|");
    const g = groups.get(key);
    if (g) g.dates.push(d.date);
    else groups.set(key, { sent: d, dates: [d.date] });
  }
  for (const { sent, dates } of groups.values()) {
    await prisma.ratePlan.updateMany({
      where: {
        roomTypeId, date: { in: dates }, syncedAt: null, price: sent.price,
        minStay: sent.minStay, maxStay: sent.maxStay,
        closedArrival: sent.closedArrival, closedDeparture: sent.closedDeparture,
      },
      data: { syncedAt: new Date(), syncError: null, channelPrice: new Prisma.Decimal(toChannelPrice(toNumber(sent.price), conv.rate)) },
    });
  }

  await logPush("push_rates", "SUCCESS", {
    request: {
      roomTypeId, externalRoomTypeIds: targets, ...logInfo,
      ...(conv.rate !== 1 ? { rate: conv.rate } : {}),
    },
    response: { detail },
    durationMs: Date.now() - started,
  });
  for (const d of days) notifyRateSync(roomTypeId, d.date, "synced");

  return { status: "sent", roomTypeId, days: pending.length };
}

export type RateSyncResult = {
  outcomes: RatePushOutcome[];
  sent: number;
  skipped: number;
  failed: number;
};

export async function syncRatesRange(roomTypeIds: string[], fromKey: string, toKey: string): Promise<RateSyncResult> {
  const from = fromDateKey(fromKey);
  const to = fromDateKey(toKey);
  const outcomes: RatePushOutcome[] = [];
  for (const roomTypeId of roomTypeIds) outcomes.push(await pushRates(roomTypeId, from, to));
  return {
    outcomes,
    sent: outcomes.filter((o) => o.status === "sent").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}

/**
 * Narx sync'ini navbatga qo'yadi (debounce). `jobId` da oyna raqami:
 * BullMQ tugagan job'ni 24 soat saqlaydi va o'sha id'ni rad etadi.
 */
export async function enqueueRateSync(roomTypeIds: string[], from: Date, to: Date): Promise<{ queued: boolean }> {
  if (roomTypeIds.length === 0 || !(await activeConnection())) return { queued: false };

  const fromKey = toDateKey(from) ?? "";
  const toKey = toDateKey(to) ?? "";
  const types = [...new Set(roomTypeIds)].sort();
  const window = Math.floor(Date.now() / DEBOUNCE_MS);
  const jobId = `rate_${types.join("-")}_${fromKey.replace(/-/g, "")}_${toKey.replace(/-/g, "")}_${window}`;

  const added = await enqueueWithTimeout(
    () => rateSyncQueue.add("sync", { roomTypeIds: types, from: fromKey, to: toKey }, { jobId, delay: DEBOUNCE_MS }),
    "rate-sync"
  );
  return { queued: added !== null };
}

/**
 * Admin narx belgilaganda chaqiriladi: DB'ga yozish darhol (admin
 * kutmaydi), Beds24'ga yuborish fonda. Panel `rate.sync.updated`
 * event'i orqali holatni ko'radi.
 */
export async function onRatesChanged(roomTypeIds: string[], from: Date, to: Date): Promise<void> {
  if (roomTypeIds.length === 0) return;
  const fromKey = toDateKey(from) ?? "";
  for (const id of roomTypeIds) notifyRateSync(id, fromKey, "pending");
  await enqueueRateSync(roomTypeIds, from, to);
}

// ============================================================
//  2. Beds24 -> PMS
// ============================================================

export type PullRatesResult = {
  status: "applied" | "skipped" | "failed";
  checked: number;
  changed: number;
  /** Yuborilmagan (admin o'zgartirgan) kun — ustiga yozilmadi */
  keptPending: number;
  detail?: string;
};

type RestrictionPatch = {
  minStay?: number; maxStay?: number; closedArrival?: boolean; closedDeparture?: boolean;
};

/**
 * Beds24 cheklovi PMS qatoridan farq qiladimi — farq qilsa yangi qiymatlar.
 *
 * PMS'da null (boshqarilmaydi) = neytral qiymat: kamida 1, ko'pi bilan
 * cheklovsiz (0), kirish/chiqish ochiq. Beds24 ham neytral bo'lsa hech
 * narsa yozilmaydi — aks holda birinchi tortish 365 kunni "o'zgardi"
 * deb belgilardi.
 */
function restrictionPatch(
  row: { minStay: number | null; maxStay: number | null; closedArrival: boolean | null; closedDeparture: boolean | null } | null,
  day: ExternalRateDay
): RestrictionPatch | null {
  const patch: RestrictionPatch = {};
  const rMin = day.minStay && day.minStay > 1 ? day.minStay : 1;
  if (rMin !== (row?.minStay ?? 1)) patch.minStay = rMin;
  const rMax = day.maxStay && day.maxStay > 0 ? day.maxStay : 0;
  if (rMax !== (row?.maxStay ?? 0)) patch.maxStay = rMax;
  const cta = day.closedArrival === true;
  const ctd = day.closedDeparture === true;
  if (cta !== (row?.closedArrival === true) || ctd !== (row?.closedDeparture === true)) {
    patch.closedArrival = cta;
    patch.closedDeparture = ctd;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Beds24 kalendaridagi narx va cheklovlarni PMS'ga tortadi (Beds24 ustuvor).
 *
 * NEGA DAVRIY: Beds24 narx o'zgarishi haqida webhook YUBORMAYDI.
 * Bitta so'rov obyektning barcha xonalarini oladi (~2 kredit).
 *
 * Faqat TUR darajasidagi bog'lanish (Beds24 turi = PMS tarifi). Xona
 * darajasida (Room 1 = 101) bir tarifning xonalari Beds24'da turli narxda
 * bo'lishi mumkin — PMS tarifiga qaysi biri yozilishi noaniq, shuning
 * uchun tortilmaydi (u yerda narx PMS'dan yuboriladi).
 */
export async function pullRates(daysAhead = 365): Promise<PullRatesResult> {
  const empty = { checked: 0, changed: 0, keptPending: 0 };
  if (!(await activeConnection())) return { status: "skipped", ...empty, detail: "Beds24 ulanmagan" };

  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  const mappings = channel
    ? await prisma.channelMapping.findMany({
        where: { channelId: channel.id, isActive: true, roomTypeId: { not: null }, roomId: null },
      })
    : [];
  if (mappings.length === 0) return { status: "skipped", ...empty, detail: "tur darajasidagi bog'lanish yo'q" };

  const conv = await channelConversion();
  if (!conv.ok) {
    await logPull("pull_rates", "SKIPPED", { errorMessage: conv.error });
    return { status: "skipped", ...empty, detail: conv.error };
  }

  const from = hotelToday();
  const to = addDays(from, daysAhead);

  let remote: Awaited<ReturnType<ReturnType<typeof getChannel>["getRates"]>>;
  try {
    remote = await getChannel().getRates(toDateKey(from) ?? "", toDateKey(to) ?? "");
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 300);
    await logPull("pull_rates", "FAILED", { errorMessage: detail });
    return { status: "failed", ...empty, detail };
  }

  const typeByExternal = new Map(mappings.map((m) => [m.externalRoomTypeId, m.roomTypeId!]));
  const local = await prisma.ratePlan.findMany({
    where: { roomTypeId: { in: [...typeByExternal.values()] }, date: { gte: from, lte: to } },
  });
  const localByKey = new Map(local.map((r) => [`${r.roomTypeId}|${toDateKey(r.date)}`, r]));

  let checked = 0;
  let keptPending = 0;
  const changes: Array<{
    roomTypeId: string; date: string;
    price?: { price: number; channelPrice: number };
    restrictions: RestrictionPatch | null;
  }> = [];

  for (const day of remote) {
    const roomTypeId = typeByExternal.get(day.externalRoomTypeId);
    if (!roomTypeId) continue;
    const row = localByKey.get(`${roomTypeId}|${day.date}`);
    const hasPrice = day.price !== undefined && day.price > 0;
    // Narxi yo'q kun (Beds24'da yopiq) va PMS'da ham qatori yo'q — tegilmaydi
    if (!row && !hasPrice) continue;
    checked++;

    if (row && row.syncedAt === null) { keptPending++; continue; }
    const priceChanged = hasPrice && !(row && sameChannelPrice(row, day.price!, conv.rate));
    const restrictions = restrictionPatch(row ?? null, day);
    // Yangi qator narxsiz yaratilmaydi
    if (!row && !priceChanged) continue;
    if (!priceChanged && !restrictions) continue;

    changes.push({
      roomTypeId,
      date: day.date,
      ...(priceChanged ? { price: { price: fromChannelPrice(day.price!, conv.rate), channelPrice: round2(day.price!) } } : {}),
      restrictions,
    });
  }

  // Bitta tranzaksiya: yarmida uzilsa narxlar aralash qolmasin
  if (changes.length > 0) {
    const now = new Date();
    await prisma.$transaction(
      changes.map((c) => {
        const price = c.price
          ? { price: new Prisma.Decimal(c.price.price), channelPrice: new Prisma.Decimal(c.price.channelPrice), source: "beds24" }
          : {};
        return prisma.ratePlan.upsert({
          where: { roomTypeId_date: { roomTypeId: c.roomTypeId, date: fromDateKey(c.date) } },
          // `create` faqat narx bilan keladi (yuqoridagi shart)
          create: {
            roomTypeId: c.roomTypeId, date: fromDateKey(c.date),
            price: new Prisma.Decimal(c.price?.price ?? 0), channelPrice: new Prisma.Decimal(c.price?.channelPrice ?? 0),
            ...(c.restrictions ?? {}), source: "beds24", syncedAt: now,
          },
          update: { ...price, ...(c.restrictions ?? {}), syncedAt: now, syncError: null },
        });
      })
    );
    for (const c of changes) notifyRateSync(c.roomTypeId, c.date, "synced");
  }

  await logPull("pull_rates", "SUCCESS", { response: { checked, changed: changes.length, keptPending } });
  return { status: "applied", checked, changed: changes.length, keptPending };
}
