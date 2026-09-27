/**
 * Webhook qabul qilish — TZ 10-band
 *
 * TZ 10-band ketma-ketligi: validate -> eventni saqlash -> duplicate
 * tekshirish -> queuega yuborish -> database update -> Shaxmatkani
 * update qilish.
 *
 * Shu fayl — birinchi to'rt qadam (HTTP so'rov ichida, tez).
 * `webhookProcessor.ts` — worker (Reservation yaratish, WebSocket).
 *
 * NEGA 200 DARHOL QAYTARILADI: Beds24 javobni kutadi va kechiksa
 * qayta yuboradi. Og'ir ishni HTTP so'rov ichida bajarish — takroriy
 * webhook va timeout sababi.
 *
 * HIMOYA: Beds24 webhook'ni IMZOLAMAYDI — maxfiy token URL'da
 * (`/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>`), route tekshiradi.
 */

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sanitizeForLog } from "../lib/sanitize.js";
import { getChannel } from "./channel/registry.js";
import { getBeds24Channel } from "./beds24/auth.js";
import { webhookQueue, enqueueWithTimeout } from "../queues/index.js";

export type WebhookIntake = {
  status: "accepted" | "duplicate" | "invalid";
  webhookEventId: string | null;
  eventType: string;
  externalId: string | null;
  detail?: string;
};

/**
 * Vaqtga bog'liq maydonlar — hash'ga KIRMAYDI: takroriy webhook'da bu
 * qiymatlar har safar o'zgaradi, lekin bron mazmuni bir xil.
 */
const VOLATILE_KEYS = new Set([
  "timestamp", "modifiedtime", "modifiedat", "sentat", "receivedat",
  "deliveryid", "webhookid", "requestid", "nonce",
  // Beds24 v2: qayta yuborishda `retries` oshadi, mazmun o'sha
  "retries",
]);

/** Kalitlarni tartiblab, vaqt maydonlarini tashlab, barqaror JSON */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > 12) return '"[MAX_DEPTH]"';
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v, depth + 1)).join(",") + "]";

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !VOLATILE_KEYS.has(k.toLowerCase().replace(/[-_]/g, "")))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v, depth + 1));
  return "{" + entries.join(",") + "}";
}

/** SHA-256 — bir xil MAZMUNni aniqlash uchun (kalit tartibi va vaqtdan qat'i nazar) */
export function computePayloadHash(payload: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** URL'dagi token to'g'rimi — vaqt bo'yicha solishtirish hujumidan himoyalangan */
export function webhookTokenOk(given: string, expected: string): boolean {
  if (!expected || expected.length < 16) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Payload sxemasi — bron bormi */
export function payloadHasBooking(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return Boolean(p.booking && typeof p.booking === "object");
}

// ============================================================
//  SAQLASH, DEDUP, QUEUE
// ============================================================

/**
 * Webhook'ni qabul qiladi va navbatga qo'yadi.
 *
 * Redis ishlamasa ham event DB'da QUEUED holatida qoladi — catch-up
 * (`processPendingEvents`) keyinroq oladi, ma'lumot YO'QOLMAYDI (TZ 17-band).
 */
export async function intakeWebhook(payload: unknown): Promise<WebhookIntake> {
  const channel = await getBeds24Channel();

  let eventType = "unknown";
  let externalId: string | null = null;
  try {
    const parsed = getChannel().parseWebhook(payload);
    eventType = parsed.event;
    externalId = parsed.externalId;
  } catch {
    // Parse bo'lmasa ham saqlaymiz — ma'lumot yo'qolmaydi
  }

  const payloadHash = computePayloadHash(payload);
  const rawPayload = sanitizeForLog(payload) as Prisma.InputJsonValue;

  if (!payloadHasBooking(payload)) {
    const ev = await prisma.webhookEvent.create({
      data: {
        channelId: channel.id, eventType, externalId,
        payloadHash: `${payloadHash}:${Date.now()}`,
        rawPayload, status: "NEEDS_MANUAL_ACTION",
        errorMessage: "Payload'da bron (booking) yo'q", processedAt: new Date(),
      },
    });
    return { status: "invalid", webhookEventId: ev.id, eventType, externalId, detail: "booking yo'q" };
  }

  // --- DUPLICATE (TZ 9-band, 1-qatlam) ---
  // unique(channelId, eventType, externalId, payloadHash): bir bronga
  // TURLI mazmunli webhook normal (bron yangilandi), bir xil mazmun — takror
  const existing = await prisma.webhookEvent.findFirst({
    where: { channelId: channel.id, eventType, externalId, payloadHash },
  });
  if (existing) {
    return {
      status: "duplicate",
      webhookEventId: existing.id,
      eventType,
      externalId,
      detail: `Avvalgi event: ${existing.id}`,
    };
  }

  let event;
  try {
    event = await prisma.webhookEvent.create({
      data: { channelId: channel.id, eventType, externalId, payloadHash, rawPayload, status: "QUEUED" },
    });
  } catch (e) {
    // Parallel ikki bir xil webhook — ikkinchisi takror
    if ((e as { code?: string }).code === "P2002") {
      return { status: "duplicate", webhookEventId: null, eventType, externalId };
    }
    throw e;
  }

  // Navbat — idempotent: bir event bir marta (jobId = event id)
  await enqueueWithTimeout(
    () => webhookQueue.add("process", { webhookEventId: event.id }, { jobId: event.id }),
    "beds24-webhook"
  );

  return { status: "accepted", webhookEventId: event.id, eventType, externalId };
}

// ============================================================
//  Qo'lda qayta ishlash
// ============================================================

/**
 * `NEEDS_MANUAL_ACTION` yoki `FAILED` event'ni qayta navbatga qo'yadi.
 * Admin mapping'ni to'g'rilagandan keyin ishlatiladi.
 */
export async function reprocessWebhook(id: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id } });
  if (!event) return null;

  const updated = await prisma.webhookEvent.update({
    where: { id },
    data: { status: "QUEUED", errorMessage: null, attempts: { increment: 1 } },
  });
  await enqueueWithTimeout(
    () => webhookQueue.add("process", { webhookEventId: id }, { jobId: `${id}_re_${Date.now()}` }),
    "beds24-webhook (qayta)"
  );
  return { before: event, after: updated };
}

/** Statistika — admin sahifasi uchun */
export async function getWebhookStats() {
  const grouped = await prisma.webhookEvent.groupBy({
    by: ["status"],
    where: { channel: { code: "beds24" } },
    _count: { _all: true },
  });
  const last = await prisma.webhookEvent.findFirst({
    where: { channel: { code: "beds24" } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return {
    total: grouped.reduce((s, g) => s + g._count._all, 0),
    byStatus: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
    lastAt: last?.createdAt.toISOString() ?? null,
  };
}
