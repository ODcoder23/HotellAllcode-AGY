/**
 * Beds24 webhook'i — FAQAT JURNAL (kanal kuzatuvi, 2026-09-27)
 *
 * Beds24 bron o'zgarganda `POST /api/webhooks/beds24/<token>` ga
 * yuboradi (v2: `{timeStamp, booking, infoItems, invoiceItems, ...}`,
 * `event` maydoni yo'q). PMS:
 *   1. hodisani `WebhookEvent` ga yozadi ("Bronlar jurnali")
 *   2. Beds24 broni nusxasini (`ChannelBooking`) yangilaydi va PMS bilan
 *      solishtiradi
 * PMS bronlari o'zgarmaydi — qabulxona OTA bronini qo'lda kiritadi.
 *
 * Imzo yo'q (Beds24 bermaydi) — himoya URL'dagi maxfiy token
 * (`WEBHOOK_URL_TOKEN`), route'da tekshiriladi.
 */

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { sanitizeForLog } from "../../lib/sanitize.js";
import { getBeds24Channel } from "../beds24/client.js";
import { normalizeBooking, type RawBooking } from "../beds24/api.js";
import { getExternalProperty } from "./mapping.js";
import { upsertSnapshot, rematchAll, logSync } from "./monitor.js";

function eventTypeOf(b: RawBooking | undefined): string {
  if (!b) return "unknown";
  const status = String(b.status || "").toLowerCase();
  if (status === "cancelled") return "booking.cancelled";
  if (status === "black") return "booking.blocked";
  if (b.bookingTime && b.modifiedTime && b.bookingTime === b.modifiedTime) return "booking.new";
  return "booking.modified";
}

export async function receiveWebhook(payload: unknown): Promise<{ status: string; id?: string }> {
  const channel = await getBeds24Channel();
  const body = (payload ?? {}) as { booking?: RawBooking };
  const booking = body.booking && typeof body.booking === "object" && body.booking.id ? body.booking : undefined;

  const safe = sanitizeForLog(payload) as Prisma.InputJsonValue;
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
  const eventType = eventTypeOf(booking);
  const externalId = booking ? String(booking.id) : null;

  // Aynan shu mazmun oldin kelgan bo'lsa — takror (Beds24 qayta yuboradi)
  const dup = await prisma.webhookEvent.findFirst({
    where: { channelId: channel.id, eventType, externalId, payloadHash: hash },
  });
  if (dup) return { status: "IGNORED_DUPLICATE", id: dup.id };

  const ev = await prisma.webhookEvent.create({
    data: { channelId: channel.id, eventType, externalId, payloadHash: hash, rawPayload: safe, attempts: 1 },
  });

  if (!booking) {
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: { status: "NEEDS_MANUAL_ACTION", errorMessage: "Payload'da bron (booking) yo'q", processedAt: new Date() },
    });
    await logSync("webhook_received", "SKIPPED", { request: { eventType }, errorMessage: "booking yo'q" });
    return { status: "NEEDS_MANUAL_ACTION", id: ev.id };
  }

  try {
    const prop = await getExternalProperty().catch(() => null);
    await upsertSnapshot(normalizeBooking(booking), prop?.currency ?? "USD");
    await rematchAll();
    await prisma.webhookEvent.update({ where: { id: ev.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    await logSync("webhook_received", "SUCCESS", { request: { eventType, externalId } });
    return { status: "PROCESSED", id: ev.id };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: { status: "FAILED", errorMessage: msg, processedAt: new Date() },
    });
    await logSync("webhook_received", "FAILED", { request: { eventType, externalId }, errorMessage: msg });
    return { status: "FAILED", id: ev.id };
  }
}
