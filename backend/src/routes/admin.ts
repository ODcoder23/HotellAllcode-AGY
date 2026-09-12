/**
 * Admin endpoint'lari — mapping, ulanish holati, sync loglari
 *
 * Manba: 06-XONA-MAPPING.md §3, §7
 *
 * ISH CHEGARASI: mavjud Admin Panel kodiga kirish yo'q, shuning
 * uchun bu endpoint'lar backend ichidagi alohida sahifalar bilan
 * ishlaydi (`/admin/*`). Keyinroq mavjud Admin Panelga ko'chirish
 * mumkin — API o'zgarmaydi.
 *
 * TZ 18-band: faqat ADMIN roli kirishi kerak. JWT FAZA 12 da
 * qo'shiladi — hozircha ochiq (dev).
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError, NotFoundError } from "../lib/errors.js";
import { toNumber, toDateKey } from "../lib/serialize.js";
import * as mapping from "../services/mapping.js";
import { beds24Adapter } from "../services/beds24/adapter.js";
import { getConnectionStatus } from "../services/beds24/auth.js";
import { getCreditState } from "../services/beds24/client.js";
import * as webhookSvc from "../services/webhook.js";

export const adminRouter = Router();

// ============================================================
//  Mapping (TZ 5-band)
// ============================================================

/** GET /api/admin/mapping — joriy bog'lanishlar */
adminRouter.get("/mapping", asyncHandler(async (_req, res) => {
  const list = await mapping.listMappings();
  res.json(list.map((m) => ({
    id: m.id,
    roomTypeId: m.roomTypeId,
    roomTypeLabel: m.roomType?.label,
    roomId: m.roomId,
    roomNumber: m.room?.number,
    externalRoomTypeId: m.externalRoomTypeId,
    externalUnitId: m.externalUnitId,
    createdAt: m.createdAt.toISOString(),
  })));
}));

/** GET /api/admin/mapping/health — to'liqlik tekshiruvi (06-fayl §7) */
adminRouter.get("/mapping/health", asyncHandler(async (_req, res) => {
  res.json(await mapping.getMappingHealth());
}));

/** GET /api/admin/mapping/external — Beds24'dagi turlar (tanlash uchun) */
adminRouter.get("/mapping/external", asyncHandler(async (_req, res) => {
  const status = await getConnectionStatus();
  if (!status.isConnected) {
    res.json({ connected: false, properties: [] });
    return;
  }

  try {
    const properties = await beds24Adapter.getRoomTypes();
    res.json({ connected: true, properties });
  } catch (e) {
    res.json({
      connected: true,
      properties: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}));

/** PUT /api/admin/mapping — bog'lash */
const upsertSchema = z.object({
  roomTypeId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
  externalRoomTypeId: z.string().min(1),
  externalUnitId: z.string().min(1).optional(),
});

adminRouter.put("/mapping", asyncHandler(async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  const result = await mapping.upsertMapping(parsed.data);
  res.json({ ok: true, id: result.id });
}));

/** DELETE /api/admin/mapping/:id — bog'lanishni olib tashlash */
adminRouter.delete("/mapping/:id", asyncHandler(async (req, res) => {
  const force = req.query.force === "true";
  await mapping.deleteMapping(req.params.id, { force });
  res.json({ ok: true });
}));

// ============================================================
//  Beds24 ulanishi
// ============================================================

/**
 * GET /api/admin/connection
 * TZ 13-band: token'ning o'zi HECH QACHON qaytarilmaydi —
 * faqat "ulangan/ulanmagan" holati.
 */
adminRouter.get("/connection", asyncHandler(async (_req, res) => {
  const status = await getConnectionStatus();
  const credits = getCreditState();

  res.json({
    ...status,
    credits: {
      remaining: credits.remaining,
      resetsIn: credits.resetsIn,
      isLow: credits.isLow,
    },
  });
}));

/** POST /api/admin/connection/ping — ulanishni tekshirish */
adminRouter.post("/connection/ping", asyncHandler(async (_req, res) => {
  res.json(await beds24Adapter.ping());
}));

// ============================================================
//  SyncLog (TZ 16-band)
// ============================================================

adminRouter.get("/sync-log", asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const status = req.query.status as string | undefined;

  const logs = await prisma.syncLog.findMany({
    where: status ? { status: status.toUpperCase() as never } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(logs.map((l) => ({
    id: l.id,
    action: l.action,
    direction: l.direction.toLowerCase(),
    status: l.status.toLowerCase(),
    reservationId: l.reservationId,
    roomId: l.roomId,
    attempt: l.attempt,
    errorMessage: l.errorMessage,
    durationMs: l.durationMs,
    createdAt: l.createdAt.toISOString(),
  })));
}));

/** GET /api/admin/webhook-events — kelgan webhook'lar (04-fayl) */
adminRouter.get("/webhook-events", asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const status = req.query.status as string | undefined;

  const events = await prisma.webhookEvent.findMany({
    where: status ? { status: status.toUpperCase() as never } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    externalId: e.externalId,
    status: e.status.toLowerCase(),
    attempts: e.attempts,
    errorMessage: e.errorMessage,
    processedAt: e.processedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  })));
}));

/** POST /api/admin/webhook-events/:id/reprocess — qo'lda qayta ishlash (04-fayl §7) */
adminRouter.post("/webhook-events/:id/reprocess", asyncHandler(async (req, res) => {
  const result = await webhookSvc.reprocessWebhook(req.params.id);
  if (!result) throw new NotFoundError("Webhook event");
  res.json({ ok: true, status: result.status.toLowerCase() });
}));

/** GET /api/admin/webhook-events/stats */
adminRouter.get("/webhook-events/stats", asyncHandler(async (_req, res) => {
  res.json(await webhookSvc.getWebhookStats());
}));

// ============================================================
//  Narxlar (07-fayl §8 — Q8: admin qo'lda belgilaydi)
// ============================================================

adminRouter.get("/rates", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new ValidationError("from va to kerak");

  const plans = await prisma.ratePlan.findMany({
    where: {
      date: {
        gte: new Date(`${from}T00:00:00Z`),
        lte: new Date(`${to}T00:00:00Z`),
      },
    },
    orderBy: [{ date: "asc" }, { roomTypeId: "asc" }],
  });

  res.json(plans.map((p) => ({
    roomTypeId: p.roomTypeId,
    date: toDateKey(p.date),
    price: toNumber(p.price),
    minStay: p.minStay,
    source: p.source,
    syncStatus: p.syncError ? "error" : p.syncedAt ? "synced" : "pending",
    syncError: p.syncError,
  })));
}));

// ============================================================
//  Umumiy holat — /admin bosh sahifasi uchun
// ============================================================

adminRouter.get("/status", asyncHandler(async (_req, res) => {
  const [health, connection, roomCount, resCount, failedSync, pendingWebhooks] =
    await Promise.all([
      mapping.getMappingHealth(),
      getConnectionStatus(),
      prisma.room.count({ where: { isActive: true } }),
      prisma.reservation.count({
        where: { status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] } },
      }),
      prisma.syncLog.count({ where: { status: "FAILED" } }),
      prisma.webhookEvent.count({
        where: { status: { in: ["RECEIVED", "QUEUED", "FAILED", "NEEDS_MANUAL_ACTION"] } },
      }),
    ]);

  const credits = getCreditState();

  res.json({
    phase: "5",
    mapping: {
      isComplete: health.isComplete,
      unmappedRoomCount: health.unmappedRoomCount,
      orphanCount: health.orphanMappings.length,
    },
    beds24: {
      connected: connection.isConnected,
      propertyId: connection.propertyId,
      creditsRemaining: credits.remaining,
      creditsLow: credits.isLow,
    },
    counts: {
      rooms: roomCount,
      activeReservations: resCount,
      failedSyncs: failedSync,
      pendingWebhooks,
    },
  });
}));
