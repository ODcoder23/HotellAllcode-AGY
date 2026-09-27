/**
 * Beds24 webhook — faqat jurnal (kanal kuzatuvi, 2026-09-27)
 *
 *   POST /api/webhooks/beds24/:token
 *
 * Beds24 webhook'ida imzo yo'q, shuning uchun himoya — URL'dagi maxfiy
 * token (`WEBHOOK_URL_TOKEN`). Token sozlanmagan yoki noto'g'ri bo'lsa
 * 404: endpoint borligini ham oshkor qilmaymiz.
 *
 * Qabul qilingan hodisa PMS bronlarini O'ZGARTIRMAYDI — faqat jurnalga
 * va Beds24 bron nusxasiga yoziladi (services/channel/webhook.ts).
 */

import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { receiveWebhook } from "../services/channel/webhook.js";

export const webhooksRouter = Router();

const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.rateLimitDisabled,
});

function tokenOk(given: string): boolean {
  const expected = config.beds24.webhookUrlToken;
  if (!expected || expected.length < 16) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

webhooksRouter.post("/beds24/:token", webhookLimiter, asyncHandler(async (req, res) => {
  if (!tokenOk(String(req.params.token ?? ""))) {
    res.status(404).json({ error: "Endpoint topilmadi", code: "NOT_FOUND" });
    return;
  }
  const result = await receiveWebhook(req.body);
  // Beds24 2xx olmasa qayta yuboradi — xatoni ham 200 bilan qaytaramiz,
  // u jurnalda FAILED bo'lib turadi va founder ko'radi
  res.json({ ok: true, status: result.status });
}));
