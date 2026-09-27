/**
 * Narx endpoint'lari — Narxlar paneli uchun (07-fayl §8)
 * Q8: avtomatik o'suvchi mexanizm yo'q, admin qo'lda belgilaydi.
 *
 * Narx xona TURI (kategoriya) va kun bo'yicha, so'mda. Sayt, Shaxmatka
 * va yangi bronlar shu jadvaldan hisoblaydi; mavjud bronlar summasi
 * o'zgarmaydi (bronda o'z narxi saqlanadi).
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
    minStay: p.minStay,
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
      create: { roomTypeId, date, price },
      update: { price },
    });
  }));
  await prisma.$transaction(ops);

  // Narx — pul: kim o'zgartirganini bilish kerak
  await audit({
    userId: req.user?.id,
    action: "rate.changed",
    entityType: "RatePlan",
    entityId: `${from}..${to}`,
    after: { prices, from, to, ...(weekdays ? { weekdays } : {}), days: days.length },
    ipAddress: req.ip,
  });

  res.json({ updated: ops.length, days: days.length });
}));
