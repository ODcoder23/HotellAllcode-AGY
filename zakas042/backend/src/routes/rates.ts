/**
 * Narx endpoint'lari — Narxlar paneli uchun
 * Q8: avtomatik o'suvchi mexanizm yo'q, admin qo'lda belgilaydi.
 *
 * Narx xona TURI (kategoriya) va kun bo'yicha, so'mda. Sayt, Shaxmatka
 * va yangi bronlar shu jadvaldan hisoblaydi; mavjud bronlar summasi
 * o'zgarmaydi (bronda o'z narxi saqlanadi).
 *
 * Beds24: o'zgargan narx fonda Beds24'ga ketadi (so'm / kurs = $,
 * services/rates.ts). Panel har kun uchun holatni ko'radi:
 * ● yuborildi / ○ kutmoqda / ⚠ xato. Beds24 panelida o'zgargan narx
 * soatlik tortiladi (Beds24 ustuvor, Q9).
 */

import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { toNumber, toDateKey, fromDateKey, isValidDateKey } from "../lib/serialize.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { audit } from "../services/auditLog.js";
import { MONEY_LIMITS, moneyAmount } from "../lib/moneySchema.js";
import { onRatesChanged, syncRatesRange } from "../services/rates.js";

export const ratesRouter = Router();

const dateKey = z.string().refine(isValidDateKey, "Sana 'YYYY-MM-DD' shaklida va haqiqiy bo'lishi kerak");

/** Bir so'rovda ko'pi bilan shuncha kun (bugundan 1 yil — 366 kun) */
const MAX_RANGE_DAYS = 366;

const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
};

function assertRange(start: Date, end: Date): void {
  if (end < start) throw new ValidationError("'to' sanasi 'from' dan keyin bo'lishi kerak");
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new ValidationError(`Oraliq juda uzun: ${spanDays} kun (ko'pi bilan ${MAX_RANGE_DAYS})`);
  }
}

// --- GET /api/rate-plans?from=&to= --------------------------
ratesRouter.get("/", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const { from, to } = parse(z.object({ from: dateKey, to: dateKey }), req.query);
  const start = fromDateKey(from);
  const end = fromDateKey(to);
  // Ilgari oraliq cheklanmagan edi — "2000..2100" butun jadvalni qaytarardi
  assertRange(start, end);

  const plans = await prisma.ratePlan.findMany({
    where: { date: { gte: start, lte: end } },
    orderBy: [{ date: "asc" }, { roomTypeId: "asc" }],
  });

  res.json(plans.map((p) => ({
    roomTypeId: p.roomTypeId,
    date: toDateKey(p.date),
    price: toNumber(p.price),
    // Cheklovlar (TZ 10-band): null — PMS boshqarmaydi
    minStay: p.minStay,
    maxStay: p.maxStay,
    closedArrival: p.closedArrival,
    closedDeparture: p.closedDeparture,
    // Beds24: qayerdan kelgan va yuborilganmi
    source: p.source,
    syncStatus: p.syncError ? "error" : p.syncedAt ? "synced" : "pending",
    syncError: p.syncError,
    // Beds24'dagi narx (kanal valyutasida, odatda $)
    channelPrice: p.channelPrice === null ? null : toNumber(p.channelPrice),
  })));
}));

// --- PUT /api/rate-plans — narx belgilash -------------------
const putSchema = z.object({
  from: dateKey,
  to: dateKey,
  // So'm, tur -> kechalik narx
  prices: z.record(z.string(), moneyAmount(MONEY_LIMITS.pricePerNight)),
  /**
   * Faqat shu hafta kunlari (0 = yakshanba ... 6 = shanba) — mavsumiy
   * narxda "faqat juma-shanba" kabi. Berilmasa oraliqning hamma kuni.
   */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
});

ratesRouter.put("/", requireAuth, requirePermission("rate.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { from, to, prices, weekdays } = parse(putSchema, req.body);
  const start = fromDateKey(from);
  const end = fromDateKey(to);
  assertRange(start, end);

  // Noma'lum tur — tushunarli xato (ilgari 500 / foreign key)
  const typeIds = Object.keys(prices);
  if (typeIds.length === 0) throw new ValidationError("Kamida bitta xona turi uchun narx kerak");
  const known = new Set(
    (await prisma.roomType.findMany({ where: { id: { in: typeIds } }, select: { id: true } })).map((t) => t.id)
  );
  const unknown = typeIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new ValidationError(`Noma'lum xona turi: ${unknown.join(", ")}`);

  // 0 narx — "sotuvda emas" degani: sayt bunday kunni sotmaydi.
  // Tasodifiy bo'sh maydon butun mavsumni o'chirib yubormasin
  const zero = typeIds.filter((id) => prices[id] <= 0);
  if (zero.length > 0) throw new ValidationError(`Narx 0 bo'lishi mumkin emas: ${zero.join(", ")}`);

  const days: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!weekdays || weekdays.includes(d.getUTCDay())) days.push(new Date(d));
  }
  if (days.length === 0) throw new ValidationError("Tanlangan hafta kunlari bu oraliqda yo'q");

  // Bitta tranzaksiya: yarmida uzilsa narxlar aralash qolmasin
  const ops = typeIds.flatMap((roomTypeId) => days.map((date) => {
    const price = new Prisma.Decimal(prices[roomTypeId]);
    return prisma.ratePlan.upsert({
      where: { roomTypeId_date: { roomTypeId, date } },
      create: { roomTypeId, date, price, source: "pms" },
      // Yangi narx "kutmoqda" — Beds24'ga yuboriladi, eski xato belgisi tozalanadi
      update: { price, source: "pms", syncedAt: null, syncError: null },
    });
  }));
  await prisma.$transaction(ops);

  // Beds24'ga fonda — admin kutmaydi; panel `rate.sync.updated` bilan ko'radi
  await onRatesChanged(typeIds, days[0], days[days.length - 1]);

  // Narx — pul: kim o'zgartirganini bilish kerak
  await audit({
    userId: req.user?.id,
    action: "rate.changed",
    entityType: "RatePlan",
    entityId: `${from}..${to}`,
    after: { prices, from, to, ...(weekdays ? { weekdays } : {}), days: days.length },
    ipAddress: req.ip,
  });

  res.json({ updated: ops.length, days: days.length, syncStatus: "pending" });
}));

// --- PUT /api/rate-plans/restrictions — cheklovlar (TZ 10-band) ----
//
// Har maydon: berilmasa — o'zgarmaydi; null — PMS endi boshqarmaydi
// (Beds24'ga yuborilmaydi, u yerdagisi qoladi); qiymat — qo'yiladi.
// minStay 1 va maxStay 0 — "cheklovsiz" (Beds24'da ham olib tashlanadi).
// Kirish/chiqish taqiqi Beds24'da bitta maydon: biri berilsa ikkinchisi
// qatordagi qiymat (yoki `false`) bilan birga boshqariladi.
// Faqat narxi bor kunlarga qo'yiladi — narxsiz kun tarifda yo'q.
const restrictionsSchema = z.object({
  from: dateKey,
  to: dateKey,
  roomTypeIds: z.array(z.string().min(1).max(50)).min(1).max(50),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  minStay: z.number().int().min(1).max(365).nullable().optional(),
  maxStay: z.number().int().min(0).max(364).nullable().optional(),
  closedArrival: z.boolean().nullable().optional(),
  closedDeparture: z.boolean().nullable().optional(),
}).refine(
  (v) => [v.minStay, v.maxStay, v.closedArrival, v.closedDeparture].some((x) => x !== undefined),
  "Kamida bitta cheklov kerak (minStay, maxStay, closedArrival, closedDeparture)"
);

ratesRouter.put("/restrictions", requireAuth, requirePermission("rate.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const body = parse(restrictionsSchema, req.body);
  const { from, to, roomTypeIds, weekdays, minStay, maxStay, closedArrival, closedDeparture } = body;
  const start = fromDateKey(from);
  const end = fromDateKey(to);
  assertRange(start, end);

  const known = new Set(
    (await prisma.roomType.findMany({ where: { id: { in: roomTypeIds } }, select: { id: true } })).map((t) => t.id)
  );
  const unknown = roomTypeIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new ValidationError(`Noma'lum xona turi: ${unknown.join(", ")}`);

  const days: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!weekdays || weekdays.includes(d.getUTCDay())) days.push(new Date(d));
  }
  if (days.length === 0) throw new ValidationError("Tanlangan hafta kunlari bu oraliqda yo'q");

  const rows = await prisma.ratePlan.findMany({
    where: { roomTypeId: { in: roomTypeIds }, date: { in: days } },
    select: { id: true, minStay: true, maxStay: true, closedArrival: true, closedDeparture: true },
  });
  const skipped = roomTypeIds.length * days.length - rows.length;
  if (rows.length === 0) throw new ValidationError("Bu kunlarda narx yo'q — avval narx qo'ying");

  // Kamida > ko'pi bilan — OTA bunday kunni umuman sota olmaydi
  const conflict = rows.find((r) => {
    const min = minStay !== undefined ? minStay : r.minStay;
    const max = maxStay !== undefined ? maxStay : r.maxStay;
    return min !== null && max !== null && max > 0 && min > max;
  });
  if (conflict) {
    throw new ValidationError("Kamida kecha soni ko'pi bilan kecha sonidan katta bo'lib qoladi — ikkalasini birga o'zgartiring");
  }

  const ids = rows.map((r) => r.id);
  const reset = { syncedAt: null, syncError: null };
  const ops = [
    prisma.ratePlan.updateMany({
      where: { id: { in: ids } },
      data: {
        ...reset,
        ...(minStay !== undefined ? { minStay } : {}),
        ...(maxStay !== undefined ? { maxStay } : {}),
      },
    }),
  ];
  if (closedArrival === null || closedDeparture === null) {
    ops.push(prisma.ratePlan.updateMany({ where: { id: { in: ids } }, data: { closedArrival: null, closedDeparture: null } }));
  } else {
    if (closedArrival !== undefined) {
      ops.push(prisma.ratePlan.updateMany({ where: { id: { in: ids } }, data: { closedArrival } }));
      if (closedDeparture === undefined) {
        ops.push(prisma.ratePlan.updateMany({ where: { id: { in: ids }, closedDeparture: null }, data: { closedDeparture: false } }));
      }
    }
    if (closedDeparture !== undefined) {
      ops.push(prisma.ratePlan.updateMany({ where: { id: { in: ids } }, data: { closedDeparture } }));
      if (closedArrival === undefined) {
        ops.push(prisma.ratePlan.updateMany({ where: { id: { in: ids }, closedArrival: null }, data: { closedArrival: false } }));
      }
    }
  }
  await prisma.$transaction(ops);

  await onRatesChanged(roomTypeIds, days[0], days[days.length - 1]);

  const after = { minStay, maxStay, closedArrival, closedDeparture };
  await audit({
    userId: req.user?.id,
    action: "rate.changed",
    entityType: "RatePlan",
    entityId: `${from}..${to}`,
    after: { restrictions: after, roomTypeIds, from, to, ...(weekdays ? { weekdays } : {}), days: rows.length },
    ipAddress: req.ip,
  });

  res.json({ updated: rows.length, skipped, syncStatus: "pending" });
}));

// --- POST /api/rate-plans/resync — Beds24'ga qayta yuborish ----
// Panel [↻] tugmasi: yuborilmagan / xato kunlar darhol yuboriladi.
// `all: true` — oraliqdagi HAMMA kun qayta yuboriladi (masalan
// birinchi ulanishda PMS narxlarini Beds24'ga o'tkazish uchun)
const resyncSchema = z.object({
  roomTypeIds: z.array(z.string().min(1).max(50)).min(1).max(50),
  from: dateKey,
  to: dateKey,
  all: z.boolean().optional(),
});

ratesRouter.post("/resync", requireAuth, requirePermission("rate.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { roomTypeIds, from, to, all } = parse(resyncSchema, req.body);
  const start = fromDateKey(from);
  const end = fromDateKey(to);
  assertRange(start, end);

  await prisma.ratePlan.updateMany({
    where: {
      roomTypeId: { in: roomTypeIds },
      date: { gte: start, lte: end },
      ...(all ? {} : { OR: [{ syncedAt: null }, { syncError: { not: null } }] }),
    },
    data: { syncedAt: null, syncError: null },
  });
  const result = await syncRatesRange(roomTypeIds, from, to);

  await audit({
    userId: req.user?.id,
    action: "rate.changed",
    entityType: "RatePlan",
    entityId: `${from}..${to}`,
    after: { resync: true, all: !!all, roomTypeIds, sent: result.sent, failed: result.failed },
    ipAddress: req.ip,
  });
  res.json(result);
}));
