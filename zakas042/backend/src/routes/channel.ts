/**
 * Channel manager (Beds24 kuzatuvi) va dollar kursi — FAQAT FOUNDER
 *
 * 2026-09-27, egasi qarori: 2026-09-26 da olib tashlangan Channel
 * manager bo'limi egasi uchun qaytadi — lekin KUZATUV REJIMIDA. PMS
 * Beds24'dan o'qiydi va solishtiradi; PMS bronlariga va Beds24'ga
 * hech narsa yozmaydi. Boshqa rollar bu endpoint'larni ko'rmaydi (403).
 *
 * `/api/admin` ostida ulanadi (eski manzillar saqlangan):
 *   ulanish     GET/POST/DELETE /connection, POST /connection/ping,
 *               GET /status, GET /channel-health
 *   mapping     GET/PUT /mapping, DELETE /mapping/:id, GET /mapping/external,
 *               GET /mapping/health, POST /mapping/auto-units,
 *               PATCH /mappings/:id/meal
 *   jurnallar   GET /sync-log, GET /webhook-events, GET /webhook-events/stats,
 *               GET /channel/bookings
 *   tekshiruv   POST /maintenance/{poll, pull-rates, drift}
 *   narxlar     GET /rates (PMS narxi + $ + Beds24 narxi)
 *   kurs        GET/PUT /fx, POST /fx/refresh
 *   Shaxmatka   GET /channel/reservation/:id
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { isValidDateKey, toDateKey } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { audit } from "../services/auditLog.js";
import { connect, disconnect, Beds24Error, getCreditState } from "../services/beds24/client.js";
import {
  autoMapUnits,
  deleteMapping,
  getExternalProperty,
  invalidatePropertyCache,
  listMappings,
  mappingHealth,
  setMappingMeal,
  upsertMapping,
} from "../services/channel/mapping.js";
import {
  channelSummary,
  connectionStatus,
  driftCheck,
  lastDrift,
  listChannelBookings,
  listSyncLog,
  listWebhookEvents,
  logSync,
  pingConnection,
  pollBookings,
  pullRates,
  ratesComparison,
  reservationChannelInfo,
  webhookStats,
} from "../services/channel/monitor.js";
import { getFx, refreshFxFromCbu, setManualFx } from "../services/fx.js";

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

// ============================================================
//  Ulanish
// ============================================================

channelRouter.get("/connection", ...read, asyncHandler(async (_req, res) => {
  res.json(await connectionStatus());
}));

const connectSchema = z.object({
  inviteCode: z.string().min(4).max(500).optional(),
  refreshToken: z.string().min(10).max(2000).optional(),
  propertyId: z.string().regex(/^\d+$/, "faqat raqam").max(20).optional(),
}).refine((v) => !!v.inviteCode !== !!v.refreshToken, "inviteCode YOKI refreshToken (bittasi)");

channelRouter.post("/connection", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const body = parse(connectSchema, req.body);
  try {
    const conn = await connect(body);
    invalidatePropertyCache();
    await logSync("connect", "SUCCESS", { response: { propertyId: conn.propertyId, via: body.inviteCode ? "invite" : "refresh" } });
    await audit({
      userId: req.user?.id,
      action: "channel.connected",
      entityType: "ChannelConnection",
      entityId: conn.id,
      after: { propertyId: conn.propertyId, via: body.inviteCode ? "invite_code" : "refresh_token" },
      ipAddress: req.ip,
    });
    // Darhol tekshiramiz — founder natijani shu zahoti ko'rsin
    const ping = await pingConnection();
    res.status(201).json({ connection: await connectionStatus(), ping });
  } catch (e) {
    if (e instanceof Beds24Error) throw new ValidationError(e.message);
    throw e;
  }
}));

channelRouter.delete("/connection", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const count = await disconnect();
  invalidatePropertyCache();
  await logSync("disconnect", "SUCCESS", { response: { count } });
  await audit({ userId: req.user?.id, action: "channel.disconnected", entityType: "ChannelConnection", ipAddress: req.ip });
  res.json({ disconnected: count });
}));

channelRouter.post("/connection/ping", ...read, asyncHandler(async (_req, res) => {
  res.json(await pingConnection());
}));

channelRouter.get(["/status", "/channel-health"], ...read, asyncHandler(async (_req, res) => {
  res.json(await channelSummary());
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
  try {
    res.json({ property: await getExternalProperty(req.query.refresh === "1"), credits: getCreditState() });
  } catch (e) {
    if (e instanceof Beds24Error) throw new ValidationError(e.message);
    throw e;
  }
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
  const row = await upsertMapping(body);
  await audit({ userId: req.user?.id, action: "mapping.updated", entityType: "ChannelMapping", entityId: row.id, after: body, ipAddress: req.ip });
  res.json(row);
}));

channelRouter.delete("/mapping/:id", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const row = await deleteMapping(String(req.params.id));
  await audit({ userId: req.user?.id, action: "mapping.deleted", entityType: "ChannelMapping", entityId: row.id, before: row, ipAddress: req.ip });
  res.json({ deleted: row.id });
}));

channelRouter.post("/mapping/auto-units", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const result = await autoMapUnits();
    await audit({ userId: req.user?.id, action: "mapping.updated", entityType: "ChannelMapping", after: { auto: result.mapped.length }, ipAddress: req.ip });
    res.json({ ...result, health: await mappingHealth() });
  } catch (e) {
    if (e instanceof Beds24Error) throw new ValidationError(e.message);
    throw e;
  }
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
  res.json(await listSyncLog(q));
}));

channelRouter.get("/webhook-events", ...read, asyncHandler(async (req, res) => {
  const q = parse(z.object({ limit: limitQ, status: z.string().max(40).optional() }), req.query);
  res.json(await listWebhookEvents(q));
}));

channelRouter.get("/webhook-events/stats", ...read, asyncHandler(async (_req, res) => {
  res.json(await webhookStats());
}));

channelRouter.get("/channel/bookings", ...read, asyncHandler(async (req, res) => {
  const q = parse(z.object({
    match: z.enum(["MATCHED", "MISMATCH", "MISSING_IN_PMS", "UNMAPPED", "INACTIVE"]).optional(),
    past: z.enum(["0", "1"]).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }), req.query);
  res.json(await listChannelBookings({ match: q.match, includePast: q.past === "1", limit: q.limit }));
}));

channelRouter.get("/channel/drift", ...read, asyncHandler(async (_req, res) => {
  res.json(await lastDrift());
}));

channelRouter.get("/channel/reservation/:id", ...read, asyncHandler(async (req, res) => {
  res.json(await reservationChannelInfo(String(req.params.id)));
}));

// ============================================================
//  Qo'lda tekshirish (Beds24'dan o'qish)
// ============================================================

channelRouter.post("/maintenance/poll", ...read, asyncHandler(async (_req, res) => {
  res.json(await pollBookings());
}));

channelRouter.post("/maintenance/pull-rates", ...read, asyncHandler(async (_req, res) => {
  res.json(await pullRates());
}));

channelRouter.post("/maintenance/drift", ...read, asyncHandler(async (_req, res) => {
  res.json(await driftCheck());
}));

// ============================================================
//  Narxlar (PMS + $ + Beds24)
// ============================================================

channelRouter.get("/rates", ...read, asyncHandler(async (req, res) => {
  const today = hotelToday();
  const from = String(req.query.from ?? toDateKey(today));
  const to = String(req.query.to ?? toDateKey(addDays(today, 30)));
  if (!isValidDateKey(from) || !isValidDateKey(to)) throw new ValidationError("from/to: YYYY-MM-DD");
  res.json(await ratesComparison(from, to));
}));

// ============================================================
//  Dollar kursi
// ============================================================

channelRouter.get("/fx", ...read, asyncHandler(async (_req, res) => {
  res.json({ fx: await getFx() });
}));

channelRouter.put("/fx", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const { rate } = parse(z.object({ rate: z.number().positive() }), req.body);
  const before = await getFx();
  const fx = await setManualFx(rate, req.user?.id);
  await audit({ userId: req.user?.id, action: "fx.changed", entityType: "Settings", entityId: "FX_RATE_USD", before, after: fx, ipAddress: req.ip });
  res.json({ fx });
}));

channelRouter.post("/fx/refresh", ...write, asyncHandler(async (req: AuthedRequest, res) => {
  const before = await getFx();
  const started = Date.now();
  try {
    const { fx } = await refreshFxFromCbu({ force: true, userId: req.user?.id });
    await logSync("fx_refresh", "SUCCESS", { response: fx, durationMs: Date.now() - started });
    await audit({ userId: req.user?.id, action: "fx.changed", entityType: "Settings", entityId: "FX_RATE_USD", before, after: fx, ipAddress: req.ip });
    res.json({ fx });
  } catch (e) {
    await logSync("fx_refresh", "FAILED", { errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started });
    throw e;
  }
}));
