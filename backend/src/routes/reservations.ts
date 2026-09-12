/**
 * Bron endpoint'lari — Shaxmatka uchun
 *
 * Har endpoint frontenddagi funksiyaga mos:
 *   createReservation  → POST   /api/reservations
 *   checkIn            → POST   /api/reservations/:id/check-in
 *   checkOutRes        → POST   /api/reservations/:id/check-out
 *   cancelRes          → POST   /api/reservations/:id/cancel
 *   changeRoom         → POST   /api/reservations/:id/change-room
 *   changeDates        → POST   /api/reservations/:id/change-dates
 *   addPayment         → POST   /api/reservations/:id/payments
 *   reversePayment     → POST   /api/reservations/:id/payments/:pid/reverse
 *   addCharge          → POST   /api/reservations/:id/charges
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { audit } from "../services/auditLog.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { serializeReservation } from "../lib/serialize.js";
import * as svc from "../services/reservations.js";

export const reservationsRouter = Router();

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Sana 'YYYY-MM-DD' shaklida bo'lishi kerak");

const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
};

// --- GET /api/reservations ----------------------------------
reservationsRouter.get("/", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const list = await svc.listReservations(from, to);
  res.json(list.map(serializeReservation));
}));

// --- GET /api/reservations/:id ------------------------------
reservationsRouter.get("/:id", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const r = await svc.getReservation(req.params.id);
  res.json(serializeReservation(r));
}));

// --- POST /api/reservations ---------------------------------
const createSchema = z.object({
  roomId: z.string().min(1),
  guestName: z.string().min(1, "Mehmon ismi kerak"),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  checkIn: dateKey,
  checkOut: dateKey,
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  source: z.string().optional(),
  pricePerNight: z.number().min(0),
  notes: z.string().optional(),
  withMeal: z.boolean().optional(),
  status: z.string().optional(),
  initialPayment: z.number().min(0).optional(),
  paymentMethod: z.string().optional(),
});

reservationsRouter.post("/", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req, res) => {
  const input = parse(createSchema, req.body);
  const r = await svc.createReservation(input);
  res.status(201).json(serializeReservation(r));
}));

// --- PATCH /api/reservations/:id ----------------------------
const patchSchema = z.object({
  guestName: z.string().min(1).optional(),
  phone: z.string().optional(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  pricePerNight: z.number().min(0).optional(),
  notes: z.string().optional(),
  withMeal: z.boolean().optional(),
});

reservationsRouter.patch("/:id", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req, res) => {
  const patch = parse(patchSchema, req.body);
  const r = await svc.updateReservation(req.params.id, patch);
  res.json(serializeReservation(r));
}));

// --- Status amallari ----------------------------------------
// Tasdiqlash: PENDING_PAYMENT -> CONFIRMED (13-fayl §5).
// `reservation.write` huquqi: MANAGER ham to'lovni tasdiqlaydi.
reservationsRouter.post("/:id/confirm", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req, res) => {
  res.json(serializeReservation(await svc.confirmReservation(req.params.id)));
}));

reservationsRouter.post("/:id/check-in", requireAuth, requirePermission("checkin.write"), asyncHandler(async (req, res) => {
  res.json(serializeReservation(await svc.checkIn(req.params.id)));
}));

reservationsRouter.post("/:id/check-out", requireAuth, requirePermission("checkin.write"), asyncHandler(async (req, res) => {
  res.json(serializeReservation(await svc.checkOut(req.params.id)));
}));

reservationsRouter.post("/:id/cancel", requireAuth, requirePermission("reservation.cancel"), asyncHandler(async (req: AuthedRequest, res) => {
  const result = await svc.cancelReservation(req.params.id);

  // 10-fayl §4: kim bekor qildi — pul bilan bog'liq amal
  await audit({
    userId: req.user?.id,
    action: "reservation.cancelled",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { guestName: result.guest?.fullName, checkIn: result.checkIn },
    ipAddress: req.ip,
  });

  res.json(serializeReservation(result));
}));

reservationsRouter.post("/:id/no-show", requireAuth, requirePermission("reservation.cancel"), asyncHandler(async (req: AuthedRequest, res) => {
  const result = await svc.markNoShow(req.params.id);

  // 10-fayl §4: kim "kelmadi" deb belgiladi
  await audit({
    userId: req.user?.id,
    action: "reservation.no_show",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { guestName: result.guest?.fullName, checkIn: result.checkIn },
    ipAddress: req.ip,
  });

  res.json(serializeReservation(result));
}));

// --- Xona / sana o'zgartirish -------------------------------
reservationsRouter.post("/:id/change-room", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req, res) => {
  const { roomId } = parse(z.object({ roomId: z.string().min(1) }), req.body);
  res.json(serializeReservation(await svc.changeRoom(req.params.id, roomId)));
}));

reservationsRouter.post("/:id/change-dates", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req, res) => {
  const { checkIn, checkOut } = parse(
    z.object({ checkIn: dateKey, checkOut: dateKey }),
    req.body
  );
  res.json(serializeReservation(await svc.changeDates(req.params.id, checkIn, checkOut)));
}));

// --- To'lov va xarajat --------------------------------------
reservationsRouter.post("/:id/payments", requireAuth, requirePermission("payment.write"), asyncHandler(async (req, res) => {
  const { amount, method, note } = parse(
    z.object({
      amount: z.number(),
      method: z.string().min(1),
      note: z.string().optional(),
    }),
    req.body
  );
  res.status(201).json(serializeReservation(await svc.addPayment(req.params.id, amount, method, note)));
}));

reservationsRouter.post("/:id/payments/:pid/reverse", requireAuth, requirePermission("payment.write"), asyncHandler(async (req, res) => {
  res.json(serializeReservation(await svc.reversePayment(req.params.id, req.params.pid)));
}));

reservationsRouter.post("/:id/charges", requireAuth, requirePermission("payment.write"), asyncHandler(async (req, res) => {
  const { label, amount } = parse(
    z.object({ label: z.string().min(1), amount: z.number() }),
    req.body
  );
  res.status(201).json(serializeReservation(await svc.addCharge(req.params.id, label, amount)));
}));
