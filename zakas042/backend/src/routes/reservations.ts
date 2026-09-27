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
import { requireAuth, requirePermission, authRequired, type AuthedRequest } from "../lib/authMiddleware.js";
import { can } from "../services/auth.js";
import { audit } from "../services/auditLog.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { fromDateKey, isValidDateKey, serializeReservation } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import * as svc from "../services/reservations.js";
import { getFx } from "../services/fx.js";
import {
  MONEY_LIMITS, moneyAmount, nightPriceAmount, positiveMoney, signedMoney,
} from "../lib/moneySchema.js";

export const reservationsRouter = Router();

/**
 * "YYYY-MM-DD" va haqiqiy kalendar sanasi. "2026-02-31" shaklan
 * to'g'ri, lekin ilgari jimgina 3-martga aylanib bron yaratardi.
 */
const dateKey = z.string().refine(isValidDateKey, "Sana 'YYYY-MM-DD' shaklida va haqiqiy bo'lishi kerak");

/** Bron manbalari — Shaxmatka SOURCES kalitlari (Prisma enum bilan bir xil) */
const SOURCE_KEYS = [
  "direct", "website", "booking_com", "airbnb", "expedia", "ostrovok", "phone", "walk_in", "other",
] as const;

const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
};

// --- GET /api/reservations?from=&to= ------------------------
// Ikkalasi berilmasa — hammasi. Noto'g'ri sana 400 (ilgari 500 edi)
reservationsRouter.get("/", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const { from, to } = parse(
    z.object({ from: dateKey.optional(), to: dateKey.optional() }),
    req.query
  );
  const list = await svc.listReservations(from, to);
  res.json(list.map(serializeReservation));
}));

// --- GET /api/reservations/fx-rate --------------------------
// Dollar kursi — faqat ko'rsatish uchun, FAQAT FOUNDER (2026-09-27).
// Shaxmatka bron oynasida so'm tagida $ chiqaradi. `/:id` dan OLDIN.
reservationsRouter.get("/fx-rate", requireAuth, requirePermission("channel.read"), asyncHandler(async (_req, res) => {
  res.json({ fx: await getFx() });
}));

// --- GET /api/reservations/:id ------------------------------
reservationsRouter.get("/:id", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const r = await svc.getReservation(req.params.id);
  res.json(serializeReservation(r));
}));

// --- POST /api/reservations ---------------------------------

/** Narx va to'lov chegaralari (SAVOLLAR.md S5) — so'm (`lib/moneySchema.ts`) */
const nightPrice = nightPriceAmount(MONEY_LIMITS.pricePerNight);

/**
 * O'tmishga bron qilish chegarasi (SAVOLLAR.md S8).
 *
 * NEGA ruxsat bor: qabulxona kecha kelgan mehmonni ertalab
 * kiritishi odatiy hol. NEGA chegara bor: 2020-yilga bron
 * kiritish xato, va hisobotni buzadi.
 */
const MAX_BACKDATE_DAYS = 30;

function assertNotTooOld(checkIn: string): void {
  const date = fromDateKey(checkIn);
  // Mehmonxona (Toshkent) kuni bo'yicha
  const limit = addDays(hotelToday(), -MAX_BACKDATE_DAYS);

  if (date < limit) {
    throw new ValidationError(
      `Kirish sanasi juda eski — ${MAX_BACKDATE_DAYS} kundan oldingi ` +
      `sanaga bron kiritib bo'lmaydi`
    );
  }
}

/**
 * Matn maydonlari uzunligi cheklangan.
 *
 * NEGA: cheklovsiz 10 000 belgilik ism DB'ga tushib, Shaxmatka
 * jadvalini buzadi. Yuzlab shunday bron esa DB'ni shishiradi.
 * Bu hujum emas, lekin himoyasi arzon.
 */
/**
 * Telefon MAJBURIY (2026-09-17 qarori, SAVOLLAR.md S7).
 *
 * NEGA: telefonsiz bron har safar YANGI mehmon yozuvi yaratardi —
 * bir odam besh marta kelsa bazada besh yozuv. Ustiga mehmonga
 * bog'lanib bo'lmasdi (xona o'zgardi, kech qoldi).
 *
 * Kamida 7 belgi: "+998901234567" ham, ichki "1204" ham o'tsin,
 * lekin bo'sh yoki "-" o'tmasin.
 */
const phoneSchema = z
  .string({ required_error: "Telefon raqami kerak" })
  .trim()
  .min(7, "Telefon raqami kerak (kamida 7 belgi)")
  .max(30);

const createSchema = z.object({
  roomId: z.string().min(1).max(50),
  guestName: z.string().min(1, "Mehmon ismi kerak").max(200, "Ism juda uzun"),
  phone: phoneSchema,
  email: z.string().email().max(200).optional(),
  checkIn: dateKey,
  checkOut: dateKey,
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  // Noma'lum qiymat ilgari Prisma enum xatosi bilan 500 berardi
  source: z.string().transform((v) => v.toLowerCase()).pipe(z.enum(SOURCE_KEYS)).optional(),
  pricePerNight: nightPrice,
  // Narx tarifdan past bo'lsa sabab (S4) — servis qatlami talab qiladi
  priceReason: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  withMeal: z.boolean().optional(),
  /**
   * Faqat boshlang'ich holatlar. Ilgari istalgan status qabul qilinardi —
   * bronni to'g'ridan-to'g'ri "chiqib ketgan" yoki "bekor qilingan"
   * holatda yaratib, status o'tish qoidalarini (va tozalash, xona
   * holatini) chetlab o'tish mumkin edi. Kirish — alohida amal.
   */
  status: z.string().transform((v) => v.toLowerCase()).pipe(z.enum(["confirmed", "pending_payment"])).optional(),
  initialPayment: moneyAmount(MONEY_LIMITS.payment).optional(),
  paymentMethod: z.string().max(50).optional(),
});

reservationsRouter.post("/", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const input = parse(createSchema, req.body);
  assertNotTooOld(input.checkIn);

  // To'lovni kim qabul qilgani yozilsin (S13)
  const r = await svc.createReservation({ ...input, userId: req.user?.id });
  res.status(201).json(serializeReservation(r));
}));

// --- PATCH /api/reservations/:id ----------------------------
const patchSchema = z.object({
  guestName: z.string().min(1).max(200).optional(),
  phone: z.string().max(30).optional(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  pricePerNight: nightPrice.optional(),
  priceReason: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  withMeal: z.boolean().optional(),
});

reservationsRouter.patch("/:id", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req, res) => {
  const patch = parse(patchSchema, req.body);
  const r = await svc.updateReservation(req.params.id, patch);
  res.json(serializeReservation(r));
}));

// --- PUT /api/reservations/:id/external-ref -----------------
// OTA bron raqami (Booking.com #...) — FAQAT FOUNDER (2026-09-27).
// Kanal kuzatuvi Beds24 bronini PMS broni bilan shu raqam orqali aniq
// solishtiradi. Bron summasi, sanasi, holatiga ta'sir qilmaydi.
reservationsRouter.put("/:id/external-ref", requireAuth, requirePermission("channel.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { externalReference } = parse(
    z.object({ externalReference: z.string().trim().max(100).nullable() }),
    req.body
  );
  const value = externalReference || null;
  const before = await svc.getReservation(req.params.id);
  const r = await svc.setExternalReference(req.params.id, value);
  await audit({
    userId: req.user?.id,
    action: "reservation.external_ref",
    entityType: "Reservation",
    entityId: req.params.id,
    before: { externalReference: before.externalReference },
    after: { externalReference: value },
    ipAddress: req.ip,
  });
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

/**
 * Bekor qilish jarimasini OLDINDAN ko'rsatadi (SAVOLLAR.md S11).
 *
 * Frontend "Bekor qilish" tugmasi bosilganda chaqiradi:
 * xodim "1 kecha narxi (800 000 so'm) olinadi" degan
 * ogohlantirishni ko'radi va tasdiqlaydi.
 */
reservationsRouter.get("/:id/cancel-preview", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  res.json(await svc.previewCancellation(req.params.id));
}));

reservationsRouter.post("/:id/cancel", requireAuth, requirePermission("reservation.cancel"), asyncHandler(async (req: AuthedRequest, res) => {
  const result = await svc.cancelReservation(req.params.id);

  // 10-fayl §4: kim bekor qildi — pul bilan bog'liq amal
  await audit({
    userId: req.user?.id,
    action: "reservation.cancelled",
    entityType: "Reservation",
    entityId: req.params.id,
    after: {
      guestName: result.guest?.fullName,
      checkIn: result.checkIn,
      // Jarima pul bilan bog'liq — jurnalda qolsin (S11)
      cancellationFee: result.cancellationFee ? Number(result.cancellationFee) : 0,
    },
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
  assertNotTooOld(checkIn);
  res.json(serializeReservation(await svc.changeDates(req.params.id, checkIn, checkOut)));
}));

// --- To'lov va xarajat --------------------------------------
// To'lov summasi ham cheklangan: juda katta summa — xato kiritish
// belgisi (qo'shimcha nol). Manfiy — qaytarish.
reservationsRouter.post("/:id/payments", requireAuth, requirePermission("payment.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { amount, method, note } = parse(
    z.object({
      amount: signedMoney(MONEY_LIMITS.payment),
      method: z.string().min(1).max(50),
      note: z.string().max(500).optional(),
    }),
    req.body
  );

  // Manfiy summa — qaytarish: alohida huquq (qabulxonada yo'q)
  if (amount < 0 && authRequired() && !(req.user && can(req.user.role, "payment.refund"))) {
    res.status(403).json({
      error: "Bu amal uchun huquq yetarli emas: payment.refund",
      code: "FORBIDDEN",
      required: "To'lovni qaytarish",
    });
    return;
  }

  const result = await svc.addPayment(req.params.id, amount, method, note, req.user?.id);

  // 10-fayl §4: pul harakati har doim jurnalda qolsin (S13)
  await audit({
    userId: req.user?.id,
    action: amount >= 0 ? "payment.received" : "payment.refunded",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { amount, method },
    ipAddress: req.ip,
  });

  res.status(201).json(serializeReservation(result));
}));

reservationsRouter.post("/:id/payments/:pid/reverse", requireAuth, requirePermission("payment.refund"), asyncHandler(async (req: AuthedRequest, res) => {
  const result = await svc.reversePayment(req.params.id, req.params.pid, req.user?.id);

  await audit({
    userId: req.user?.id,
    action: "payment.reversed",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { paymentId: req.params.pid },
    ipAddress: req.ip,
  });

  res.json(serializeReservation(result));
}));

reservationsRouter.post("/:id/charges", requireAuth, requirePermission("payment.write"), asyncHandler(async (req, res) => {
  const { label, amount } = parse(
    z.object({
      label: z.string().min(1).max(200),
      amount: positiveMoney(MONEY_LIMITS.payment),
    }),
    req.body
  );
  res.status(201).json(serializeReservation(await svc.addCharge(req.params.id, label, amount)));
}));
