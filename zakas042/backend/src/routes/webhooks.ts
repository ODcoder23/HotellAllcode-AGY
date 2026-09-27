/**
 * Beds24 webhook — TZ 10-band
 *
 *   POST /api/webhooks/beds24/:token
 *
 * Beds24 webhook'ida imzo yo'q, shuning uchun himoya — URL'dagi maxfiy
 * token (`WEBHOOK_URL_TOKEN`). Token sozlanmagan yoki noto'g'ri bo'lsa
 * 404: endpoint borligini ham oshkor qilmaymiz, bazaga ham yozilmaydi
 * (skanerlar jurnalni to'ldirmasin).
 *
 * 200 DARHOL qaytariladi: Beds24 javobni kutadi va kechiksa qayta
 * yuboradi. Bu yerda faqat: tekshirish -> saqlash -> dedup -> navbat.
 * Bron yaratish worker'da (services/webhookProcessor.ts).
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { intakeWebhook, webhookTokenOk } from "../services/webhook.js";

export const webhooksRouter = Router();

const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.rateLimitDisabled,
});

webhooksRouter.post("/beds24/:token", webhookLimiter, asyncHandler(async (req, res) => {
  if (!webhookTokenOk(String(req.params.token ?? ""), config.beds24.webhookUrlToken)) {
    res.status(404).json({ error: "Endpoint topilmadi", code: "NOT_FOUND" });
    return;
  }
  const result = await intakeWebhook(req.body);
  // Takror va bronsiz payload ham 200 — Beds24 qayta yubormasin (jurnalda turadi)
  res.json({ ok: true, status: result.status, eventId: result.webhookEventId });
}));
