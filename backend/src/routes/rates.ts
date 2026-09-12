/**
 * Narx endpoint'lari — Narxlar paneli uchun (07-fayl §8)
 * Q8: avtomatik o'suvchi mexanizm yo'q, admin qo'lda belgilaydi.
 */

import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { toNumber, toDateKey, fromDateKey } from "../lib/serialize.js";

export const ratesRouter = Router();

// --- GET /api/rate-plans?from=&to= --------------------------
ratesRouter.get("/", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new ValidationError("from va to parametrlari kerak");

  const plans = await prisma.ratePlan.findMany({
    where: { date: { gte: fromDateKey(from), lte: fromDateKey(to) } },
    orderBy: [{ date: "asc" }, { roomTypeId: "asc" }],
  });

  res.json(plans.map((p) => ({
    roomTypeId: p.roomTypeId,
    date: toDateKey(p.date),
    price: toNumber(p.price),
    minStay: p.minStay,
    source: p.source,
    syncStatus: p.syncedAt ? "synced" : "pending",
  })));
}));

// --- PUT /api/rate-plans — narx belgilash -------------------
const putSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prices: z.record(z.string(), z.number().min(0)),
});

ratesRouter.put("/", asyncHandler(async (req, res) => {
  const { from, to, prices } = putSchema.parse(req.body);
  const start = fromDateKey(from);
  const end = fromDateKey(to);
  if (end < start) throw new ValidationError("'to' sanasi 'from' dan keyin bo'lishi kerak");

  let count = 0;
  for (const [roomTypeId, price] of Object.entries(prices)) {
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = new Date(d);
      await prisma.ratePlan.upsert({
        where: { roomTypeId_date: { roomTypeId, date } },
        create: { roomTypeId, date, price: new Prisma.Decimal(price), source: "pms" },
        update: { price: new Prisma.Decimal(price), source: "pms", syncedAt: null },
      });
      count++;
    }
  }

  // FAZA 9: bu yerda beds24-rate-sync job qo'yiladi
  res.json({ updated: count, syncStatus: "pending" });
}));
