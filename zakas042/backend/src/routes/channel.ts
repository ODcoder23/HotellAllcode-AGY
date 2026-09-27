/**
 * Channel manager (Beds24) va valyuta kursi — /api/admin ostida
 *
 * 2026-09-27, egasi qarori: integratsiya AVVALGIDEK qaytdi. Ruxsatlar:
 *   channel.write — FOUNDER, ADMIN: ulash, bog'lash, qo'lda amallar, kurs
 *   channel.read  — + MANAGER: holat, sinxron jurnali, webhook'lar
 * Dollar summasi bron ichida — Shaxmatkada hamma xodimga (reservation.read).
 *
 *   ulanish     GET/POST/DELETE /connection, POST /connection/ping,
 *               GET /status (= /channel-health)
 *   mapping     GET/PUT /mapping, DELETE /mapping/:id, GET /mapping/external,
 *               GET /mapping/health, POST /mapping/auto-units,
 *               PATCH /mappings/:id/meal
 *   jurnallar   GET /sync-log, GET /webhook-events, GET /webhook-events/stats,
 *               POST /webhook-events/:id/reprocess, GET /channel/reservations,
 *               GET /channel/drift, GET/POST/DELETE /dead-letters
 *   qo'lda      POST /maintenance/{poll, pull-rates, drift, catch-up, sync-blocks}
 *   kurs        GET/PUT /fx, POST /fx/refresh
 */

import { Router } from "express";
import { z } from "zod";
import type { EntitySyncStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, NotFoundError, ValidationError } from "../lib/errors.js";
import { serializeReservation, toDateKey } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import { config } from "../lib/config.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { audit } from "../services/auditLog.js";
import { connect, disconnect, getConnectionStatus, Beds24AuthError } from "../services/beds24/auth.js";
import { Beds24ApiError, RateLimitError, getCreditState } from "../services/beds24/client.js";
import { getChannel } from "../services/channel/registry.js";
import { invalidateRoomTypes } from "../services/channel/propertyCache.js";
import {
  autoMapUnits, deleteMapping, getExternalProperty, listMappings, mappingHealth,
  requeueAfterMappingChange, setMappingMeal, upsertMapping,
} from "../services/mapping.js";
import { reservationInclude } from "../services/reservations.js";
import { getWebhookStats, reprocessWebhook } from "../services/webhook.js";
import { pingChannel } from "../services/reconciliation.js";
import { syncAllRoomBlocks } from "../services/channelBlocks.js";
import { getFxRate } from "../services/exchangeRate.js";
import { applyManualFx, syncFx } from "../services/fxSync.js";
import {
  runPollNow, runPullRatesNow, runDriftCheckNow, runCatchUpNow,
} from "../queues/scheduler.js";
import { listDeadLetters, requeueDeadLetter, clearDeadLetters } from "../queues/deadLetter.js";

export const channelRouter = Router();

const read = [requireAuth, requirePermission("channel.read")];
const write = [requireAuth, requirePermission("channel.write")];

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return r.data;
}

/** Beds24 xatosi -> tushunarli 400 (500 emas: sabab — kalit, kod, ruxsat) */
async function beds24<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Beds24AuthError || e instanceof Beds24ApiError || e instanceof RateLimitError) {
      throw new ValidationError(e.message);
    }
    throw e;
  }
}

/**
 * Bog'lanish o'zgardi: bog'lanmagani uchun yuborilmagan PMS bronlari
 * qayta navbatga, Beds24 bronlari to'liq qayta import (bog'lanmagan
 * xona bronlari endi joylashadi), xona yopilishlari Beds24'ga. Fonda —
 * admin kutmaydi, natija jurnalda.
 */
function afterMappingChange(): void {
  void (async () => {
    try {
      // TARTIB: avval Beds24'dan import (qo'lda kiritilgan OTA bronlari
      // bog'lanadi), keyin PMS bronlari yuboriladi — aks holda bog'lanishi
      // kerak bo'lgan bron Beds24'ga ikkinchi marta yuborilishi mumkin
      await runPollNow(true);
      await requeueAfterMappingChange();
      await syncAllRoomBlocks();
    } catch (e) {
      console.warn(`[beds24] bog'lashdan keyingi sinxron: ${String(e).slice(0, 150)}`);
    }
  })();
}

// ============================================================
//  Ulanish
// ============================================================

async function connectionView() {
  const status = await getConnectionStatus();
  let channelCurrency: string | null = null;
  if (status.isConnected) channelCurrency = await getChannel().getCurrency().catch(() => null);
  const fx = channelCurrency ? await getFxRate(channelCurrency) : await getFxRate("USD");
  return {
    ...status,
    connected: status.isConnected,
    credits: getCreditState(),
    currency: { pms: "UZS", channel: channelCurrency },
    fx,
    webhookConfigured: config.beds24.webhookUrlToken.length >= 16,
    pollIntervalMinutes: config.beds24.pollIntervalMinutes,
    catchUpIntervalMinutes: config.beds24.pollIntervalMinutes > 0 ? config.beds24.catchUpIntervalMinutes : 0,
    baseUrl: config.beds24.baseUrl,
  };
}

channelRouter.get("/connection", ...read, asyncHandler(async (_req, res) => {
  res.json(await connectionView());
}));

const connectSchema = z.object({
  inviteCode: z.string().trim().min(4).max(500).optional(),
  refreshToken: z.string().trim().min(10).max(2000).optional(),
  propertyId: z.string().regex(/^\d+$/, "faqat raqam").max(20).optional(),
}).refine((v) => !!v.inviteCode !== !!v.refreshToken, "inviteCode YOKI refreshToken (bittasi)");

channelRouter.post("/connection", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const body = parse(connectSchema, req.body);
  const conn = await beds24(() => connect(body));
  await audit({
    userId: req.user?.id,
    action: "channel.connected",
    entityType: "ChannelConnection",
    entityId: conn.id,
    after: { propertyId: conn.propertyId, via: body.inviteCode ? "invite_code" : "refresh_token" },
    ipAddress: req.ip,
  });
  // Darhol tekshiramiz — admin natijani shu zahoti ko'rsin. Import
  // xonalar bog'langandan keyin boshlanadi (polling bog'lanishni kutadi).
  // Qayta ulash: bog'lanishlar saqlangan — uzilgan paytdagi bronlar
  // darhol ikki tomonga (Beds24'dan import, PMS'dan yuborish)
  const ping = await pingChannel();
  if (ping.ok && (await prisma.channelMapping.count({ where: { isActive: true } })) > 0) afterMappingChange();
  res.status(201).json({ connection: await connectionView(), ping });
}));

channelRouter.delete("/connection", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const count = await disconnect();
  await audit({ userId: req.user?.id, action: "channel.disconnected", entityType: "ChannelConnection", ipAddress: req.ip });
  res.json({ disconnected: count });
}));

channelRouter.post("/connection/ping", ...read, asyncHandler(async (_req, res) => {
  res.json(await pingChannel());
}));

/** Umumiy holat — Channel manager bosh sahifasi */
channelRouter.get(["/status", "/channel-health"], ...read, asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 86_400_000);
  const [connection, health, bySync, channelBookings, webhooks24h, failed24h, needsAction, lastPoll, lastDrift] =
    await Promise.all([
      connectionView(),
      mappingHealth(),
      prisma.reservation.groupBy({
        by: ["syncStatus"],
        where: { status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] }, checkOut: { gt: hotelToday() } },
        _count: { _all: true },
      }),
      prisma.reservation.count({
        where: { origin: "CHANNEL", status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] }, checkOut: { gt: hotelToday() } },
      }),
      prisma.webhookEvent.count({ where: { createdAt: { gte: since } } }),
      prisma.syncLog.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
      prisma.webhookEvent.count({ where: { status: { in: ["NEEDS_MANUAL_ACTION", "FAILED"] } } }),
      prisma.syncState.findFirst({ where: { key: "bookings_pull", channel: { code: "beds24" } } }),
      prisma.syncLog.findFirst({
        where: { action: { in: ["drift_check", "drift_detected"] } },
        orderBy: { createdAt: "desc" },
      }),
    ]);
  const sync = Object.fromEntries(bySync.map((r) => [r.syncStatus, r._count._all])) as Partial<Record<EntitySyncStatus, number>>;

  res.json({
    connection,
    mapping: health,
    reservations: {
      fromChannel: channelBookings,
      synced: sync.SYNCED ?? 0,
      pending: (sync.PENDING ?? 0) + (sync.SYNCING ?? 0),
      failed: sync.FAILED ?? 0,
      rejected: sync.REJECTED ?? 0,
      notApplicable: sync.NOT_APPLICABLE ?? 0,
    },
    lastPollAt: lastPoll?.lastSuccessfulAt?.toISOString() ?? null,
    drift: lastDrift
      ? { at: lastDrift.createdAt.toISOString(), ok: lastDrift.status === "SUCCESS", response: lastDrift.response }
      : null,
    webhooks24h,
    failed24h,
    needsAction,
  });
}));

// ============================================================
//  Mapping
// ============================================================

channelRouter.get("/mapping", ...read, asyncHandler(async (_req, res) => {
  res.json({ mappings: await listMappings(), health: await mappingHealth() });
}));

channelRouter.get("/mapping/health", ...read, asyncHandler(async (_req, res) => {
  res.json(await mappingHealth());
}));

channelRouter.get("/mapping/external", ...read, asyncHandler(async (req, res) => {
  if (req.query.refresh === "1") invalidateRoomTypes();
  const property = await beds24(() => getExternalProperty(req.query.refresh === "1"));
  res.json({ property, credits: getCreditState() });
}));

const mappingSchema = z.object({
  externalRoomTypeId: z.string().regex(/^\d+$/).max(20),
  externalUnitId: z.string().regex(/^\d+$/).max(20).nullish(),
  externalName: z.string().max(200).nullish(),
  roomTypeId: z.string().min(1).max(50).nullish(),
  roomId: z.string().min(1).max(50).nullish(),
  includesMeal: z.boolean().optional(),
});

channelRouter.put("/mapping", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const body = parse(mappingSchema, req.body);
  const { row, created } = await upsertMapping(body);
  await audit({
    userId: req.user?.id,
    action: created ? "mapping.created" : "mapping.updated",
    entityType: "ChannelMapping",
    entityId: row.id,
    after: body,
    ipAddress: req.ip,
  });
  afterMappingChange();
  res.json(row);
}));

channelRouter.delete("/mapping/:id", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const { row, activeReservations } = await deleteMapping(String(req.params.id), { force: req.query.force === "1" });
  await audit({
    userId: req.user?.id,
    action: "mapping.deleted",
    entityType: "ChannelMapping",
    entityId: row.id,
    before: row,
    after: { activeReservations },
    ipAddress: req.ip,
  });
  res.json({ deleted: row.id });
}));

channelRouter.post("/mapping/auto-units", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const result = await beds24(() => autoMapUnits());
  await audit({
    userId: req.user?.id,
    action: "mapping.updated",
    entityType: "ChannelMapping",
    after: { auto: result.mapped.length, skipped: result.skipped.length },
    ipAddress: req.ip,
  });
  if (result.mapped.length > 0) afterMappingChange();
  res.json({ ...result, health: await mappingHealth() });
}));

channelRouter.patch("/mappings/:id/meal", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const { includesMeal } = parse(z.object({ includesMeal: z.boolean() }), req.body);
  const row = await setMappingMeal(String(req.params.id), includesMeal);
  await audit({ userId: req.user?.id, action: "mapping.updated", entityType: "ChannelMapping", entityId: row.id, after: { includesMeal }, ipAddress: req.ip });
  res.json(row);
}));

// ============================================================
//  Jurnallar
// ============================================================

const limitQ = z.coerce.number().int().min(1).max(500).optional();

channelRouter.get("/sync-log", ...read, asyncHandler(async (req, res) => {
  const q = parse(z.object({
    limit: limitQ,
    action: z.string().max(40).optional(),
    status: z.enum(["SUCCESS", "FAILED", "SKIPPED", "RETRYING"]).optional(),
  }), req.query);
  const rows = await prisma.syncLog.findMany({
    where: {
      channel: { code: "beds24" },
      ...(q.action ? { action: q.action } : {}),
      ...(q.status ? { status: q.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: q.limit ?? 50,
  });
  res.json(rows.map((r) => ({
    id: r.id,
    action: r.action,
    direction: r.direction,
    status: r.status,
    reservationId: r.reservationId,
    roomId: r.roomId,
    errorMessage: r.errorMessage,
    durationMs: r.durationMs,
    response: r.response,
    createdAt: r.createdAt.toISOString(),
  })));
}));

channelRouter.get("/webhook-events", ...read, asyncHandler(async (req, res) => {
  const q = parse(z.object({ limit: limitQ, status: z.string().max(40).optional() }), req.query);
  const rows = await prisma.webhookEvent.findMany({
    where: { channel: { code: "beds24" }, ...(q.status ? { status: q.status.toUpperCase() as never } : {}) },
    orderBy: { createdAt: "desc" },
    take: q.limit ?? 50,
  });
  res.json(rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    externalId: r.externalId,
    status: r.status,
    attempts: r.attempts,
    errorMessage: r.errorMessage,
    processedAt: r.processedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  })));
}));

channelRouter.get("/webhook-events/stats", ...read, asyncHandler(async (_req, res) => {
  res.json({ ...(await getWebhookStats()), configured: config.beds24.webhookUrlToken.length >= 16 });
}));

channelRouter.post("/webhook-events/:id/reprocess", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const r = await reprocessWebhook(String(req.params.id));
  if (!r) throw new NotFoundError("Webhook");
  await audit({
    userId: req.user?.id,
    action: "webhook.reprocessed",
    entityType: "WebhookEvent",
    entityId: r.after.id,
    before: { status: r.before.status, errorMessage: r.before.errorMessage },
    after: { status: r.after.status },
    ipAddress: req.ip,
  });
  res.json({ ok: true, status: r.after.status });
}));

/**
 * Beds24 bilan bog'liq bronlar: Beds24'dan kelganlar va Beds24'ga
 * yetmaganlar (rad etilgan / xato / kutmoqda). Channel manager ->
 * "Bronlar" bo'limi.
 */
channelRouter.get("/channel/reservations", ...read, asyncHandler(async (req, res) => {
  const q = parse(z.object({
    filter: z.enum(["problems", "channel", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }), req.query);
  const filter = q.filter ?? "problems";
  const upcoming = { checkOut: { gte: addDays(hotelToday(), -1) } };
  const where =
    filter === "problems"
      ? { syncStatus: { in: ["FAILED", "REJECTED", "PENDING"] as EntitySyncStatus[] }, ...upcoming }
      : filter === "channel"
        ? { origin: "CHANNEL" as const, ...upcoming }
        : { OR: [{ origin: "CHANNEL" as const }, { externalReservationId: { not: null } }], ...upcoming };
  const rows = await prisma.reservation.findMany({
    where,
    include: reservationInclude,
    orderBy: { checkIn: "asc" },
    take: q.limit ?? 200,
  });
  res.json(rows.map(serializeReservation));
}));

/** Oxirgi farq tekshiruvi (jurnaldan — Beds24'ga so'rovsiz) */
channelRouter.get("/channel/drift", ...read, asyncHandler(async (_req, res) => {
  const row = await prisma.syncLog.findFirst({
    where: { action: { in: ["drift_check", "drift_detected"] } },
    orderBy: { createdAt: "desc" },
  });
  res.json(row ? { at: row.createdAt.toISOString(), ok: row.status === "SUCCESS", response: row.response, error: row.errorMessage } : null);
}));

channelRouter.get("/dead-letters", ...read, asyncHandler(async (req, res) => {
  const q = parse(z.object({ limit: limitQ }), req.query);
  res.json(await listDeadLetters(q.limit ?? 50).catch(() => []));
}));

channelRouter.post("/dead-letters/requeue", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(200) }), req.body);
  const result = await requeueDeadLetter(ids);
  await audit({ userId: req.user?.id, action: "channel.maintenance", entityType: "DeadLetter", after: { requeue: ids.length, ...result }, ipAddress: req.ip });
  res.json(result);
}));

channelRouter.delete("/dead-letters", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const removed = await clearDeadLetters();
  await audit({ userId: req.user?.id, action: "channel.maintenance", entityType: "DeadLetter", after: { cleared: removed }, ipAddress: req.ip });
  res.json({ removed });
}));

// ============================================================
//  Qo'lda amallar (jadval o'z vaqtida baribir ishlaydi)
// ============================================================

async function maintenance<T>(req: AuthedRequest, task: string, fn: () => Promise<T>): Promise<T> {
  const result = await beds24(fn);
  await audit({ userId: req.user?.id, action: "channel.maintenance", entityType: "Beds24", entityId: task, ipAddress: req.ip });
  return result;
}

channelRouter.post("/maintenance/poll", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  res.json(await maintenance(req, "poll", () => runPollNow(req.query.full === "1")));
}));

channelRouter.post("/maintenance/pull-rates", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  res.json(await maintenance(req, "pull-rates", () => runPullRatesNow()));
}));

channelRouter.post("/maintenance/drift", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  res.json(await maintenance(req, "drift", () => runDriftCheckNow(30)));
}));

channelRouter.post("/maintenance/catch-up", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  res.json(await maintenance(req, "catch-up", () => runCatchUpNow()));
}));

channelRouter.post("/maintenance/sync-blocks", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  res.json(await maintenance(req, "sync-blocks", () => syncAllRoomBlocks()));
}));

// ============================================================
//  Valyuta kursi (Q15)
// ============================================================

channelRouter.get("/fx", ...read, asyncHandler(async (_req, res) => {
  res.json({ fx: await getFxRate("USD") });
}));

channelRouter.put("/fx", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const { rate } = parse(z.object({ rate: z.number().positive() }), req.body);
  const before = await getFxRate("USD");
  const result = await applyManualFx("USD", rate, req.user?.id);
  const fx = await getFxRate("USD");
  await audit({ userId: req.user?.id, action: "fx.changed", entityType: "Settings", entityId: "FX_RATE_USD", before, after: fx, ipAddress: req.ip });
  res.json({ fx, backfilled: result.backfilled });
}));

channelRouter.post("/fx/refresh", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const before = await getFxRate("USD");
  const result = await syncFx({ force: true, userId: req.user?.id });
  const usd = result.rates.find((r) => r.currency === "USD");
  if (usd && "error" in usd) throw new ValidationError(usd.error);
  const fx = await getFxRate("USD");
  await audit({ userId: req.user?.id, action: "fx.changed", entityType: "Settings", entityId: "FX_RATE_USD", before, after: fx, ipAddress: req.ip });
  res.json({ fx, backfilled: result.backfilled });
}));

/** Bron tafsiloti: Beds24 bilan bog'liq ma'lumot (Shaxmatka bron oynasi) */
channelRouter.get("/channel/reservation/:id", ...read, asyncHandler(async (req, res) => {
  const r = await prisma.reservation.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true, origin: true, source: true, externalReservationId: true, externalReference: true,
      syncStatus: true, syncError: true, lastSyncedAt: true, currency: true, exchangeRate: true,
    },
  });
  if (!r) throw new NotFoundError("Bron");
  const log = await prisma.syncLog.findMany({
    where: { reservationId: r.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { action: true, status: true, errorMessage: true, createdAt: true },
  });
  res.json({
    ...r,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    exchangeRate: r.exchangeRate ? Number(r.exchangeRate) : null,
    log: log.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
    today: toDateKey(hotelToday()),
  });
}));
