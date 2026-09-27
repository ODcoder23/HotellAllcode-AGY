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
 *   (Beds24)           → POST   /api/reservations/:id/resync
 *   (Beds24)           → POST   /api/reservations/:id/channel-refresh
 *
 * Har amal Beds24'ga navbat orqali yuboriladi (services/reservationSync.ts)
 * — javob Beds24'ni kutmaydi, holat bronning `syncStatus` maydonida.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission, authRequired, type AuthedRequest } from "../lib/authMiddleware.js";
import { can } from "../services/auth.js";
import { audit } from "../services/auditLog.js";
import { asyncHandler, NotFoundError, ValidationError } from "../lib/errors.js";
import { fromDateKey, isValidDateKey, serializeReservation } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import * as svc from "../services/reservations.js";
import { getFxRate, rateFor } from "../services/exchangeRate.js";
import { activeConnection } from "../services/beds24/auth.js";
import { retryReservationSync } from "../services/reservationSync.js";
import { getChannel } from "../services/channel/registry.js";
import { applyReservation } from "../services/webhookProcessor.js";
import { Beds24AuthError } from "../services/beds24/auth.js";
import { Beds24ApiError, RateLimitError } from "../services/beds24/client.js";
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
// Bugungi dollar kursi (Q15) — HAMMA xodimga (2026-09-27, egasi qarori):
// Shaxmatka narx va bron oynasida $ ko'rsatadi, dollar bronda so'mda
// to'lovni oldindan hisoblaydi (backend baribir o'zi hisoblaydi).
// `channelConnected` — Beds24 ulanganmi: sinxron belgilari (✓ / ⚠) faqat
// shunda ko'rsatiladi. `/:id` dan OLDIN turishi shart.
reservationsRouter.get("/fx-rate", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const currency = String(req.query.currency ?? "USD").toUpperCase().slice(0, 3);
  const [rate, saved, conn] = await Promise.all([rateFor(currency), getFxRate(currency), activeConnection()]);
  res.json({
    fx: saved, currency, rate, date: saved?.date ?? null, source: saved?.source ?? null,
    channelConnected: conn !== null,
  });
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
// Audit jurnaliga servis yozadi — eski qiymat faqat tranzaksiya ichida aniq
reservationsRouter.post("/:id/change-room", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { roomId } = parse(z.object({ roomId: z.string().min(1) }), req.body);
  const actor = { userId: req.user?.id, ipAddress: req.ip };
  res.json(serializeReservation(await svc.changeRoom(req.params.id, roomId, actor)));
}));

reservationsRouter.post("/:id/change-dates", requireAuth, requirePermission("reservation.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { checkIn, checkOut } = parse(
    z.object({ checkIn: dateKey, checkOut: dateKey }),
    req.body
  );
  assertNotTooOld(checkIn);
  const actor = { userId: req.user?.id, ipAddress: req.ip };
  res.json(serializeReservation(await svc.changeDates(req.params.id, checkIn, checkOut, actor)));
}));

// --- To'lov va xarajat --------------------------------------
// To'lov summasi ham cheklangan: juda katta summa — xato kiritish
// belgisi (qo'shimcha nol). Manfiy — qaytarish.
reservationsRouter.post("/:id/payments", requireAuth, requirePermission("payment.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { amount, method, note, currency } = parse(
    z.object({
      amount: signedMoney(MONEY_LIMITS.payment),
      method: z.string().min(1).max(50),
      note: z.string().max(500).optional(),
      // Q15: dollar bronda mehmon so'mda to'lasa "UZS" (bo'sh — bron valyutasi)
      currency: z.string().regex(/^[A-Za-z]{3}$/, "Valyuta kodi 3 harf (UZS, USD)").optional(),
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

  const result = await svc.addPayment(req.params.id, amount, method, note, req.user?.id, currency);

  // 10-fayl §4: pul harakati har doim jurnalda qolsin (S13)
  await audit({
    userId: req.user?.id,
    action: amount >= 0 ? "payment.received" : "payment.refunded",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { amount, method, currency: (currency ?? result.currency).toUpperCase() },
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

reservationsRouter.post("/:id/charges", requireAuth, requirePermission("payment.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { label, amount } = parse(
    z.object({
      label: z.string().min(1).max(200),
      amount: positiveMoney(MONEY_LIMITS.payment),
    }),
    req.body
  );
  const result = await svc.addCharge(req.params.id, label, amount);

  // Xizmat mehmon qarzini oshiradi — kim qo'shgani jurnalda qolsin
  await audit({
    userId: req.user?.id,
    action: "charge.added",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { label, amount },
    ipAddress: req.ip,
  });

  res.status(201).json(serializeReservation(result));
}));

// --- POST /api/reservations/:id/resync -----------------------
// Beds24 rad etgan / yubora olmagan bronni qayta yuborish (xona yoki
// sana o'zgartirilgandan keyin, yoki Beds24'da joy bo'shagach).
// Natija darhol javobda: yuborildi / yana rad etildi.
reservationsRouter.post("/:id/resync", requireAuth, requirePermission("channel.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const outcome = await retryReservationSync(req.params.id);
  await audit({
    userId: req.user?.id,
    action: "reservation.sync_retry",
    entityType: "Reservation",
    entityId: req.params.id,
    after: outcome,
    ipAddress: req.ip,
  });
  const r = await svc.getReservation(req.params.id);
  res.json({ outcome, reservation: serializeReservation(r) });
}));

// --- POST /api/reservations/:id/channel-refresh ---------------
// "Beds24'dan qayta olish" (TZ 14-band `getBooking()`): bron Beds24'dan
// o'qiladi va webhook/polling bilan bir xil yo'ldan (`applyReservation`)
// qo'llanadi. PMS'dagi o'zgarish hali yuborilmagan bo'lsa ustiga
// yozilmaydi — natija javobda.
reservationsRouter.post("/:id/channel-refresh", requireAuth, requirePermission("channel.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const current = await svc.getReservation(req.params.id);
  if (!current.externalReservationId) throw new ValidationError("Bron Beds24 bilan bog'lanmagan");
  if (!(await activeConnection())) throw new ValidationError("Beds24 ulanmagan");

  let ext;
  try {
    ext = await getChannel().getBooking(current.externalReservationId);
  } catch (e) {
    if (e instanceof Beds24AuthError || e instanceof Beds24ApiError || e instanceof RateLimitError) {
      throw new ValidationError(e.message);
    }
    throw e;
  }
  if (!ext) throw new NotFoundError("Beds24'dagi bron");

  const result = await applyReservation(ext);
  await audit({
    userId: req.user?.id,
    action: "reservation.channel_refresh",
    entityType: "Reservation",
    entityId: req.params.id,
    after: { status: result.status, detail: result.detail },
    ipAddress: req.ip,
  });
  const r = await svc.getReservation(req.params.id);
  res.json({ result: { status: result.status, detail: result.detail }, reservation: serializeReservation(r) });
}));
