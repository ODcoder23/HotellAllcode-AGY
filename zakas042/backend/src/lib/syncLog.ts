/**
 * SyncLog yozish — TZ 16-band
 *
 * TZ 16-band aynan sakkiz maydonni talab qiladi:
 *   timestamp, direction, action, reservation_id, request,
 *   response, status, error_message
 *
 * `createdAt` = TZ'dagi `timestamp`.
 *
 * Ikki yo'nalish ham shu yerdan yozadi: Beds24 -> PMS (webhook, polling,
 * narx tortish) va PMS -> Beds24 (bron, narx, yopish yuborish).
 *
 * MUHIM: log yozish asosiy amalni yiqitmasligi kerak (TZ 17-band).
 * Xato bo'lsa konsolga tushadi, exception tashlanmaydi.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { sanitizeForLog } from "./sanitize.js";

export type SyncLogStatus = "SUCCESS" | "FAILED" | "SKIPPED";
export type SyncLogDirection = "PMS_TO_CHANNEL" | "CHANNEL_TO_PMS";

export type SyncLogInput = {
  action: string;
  direction: SyncLogDirection;
  status: SyncLogStatus;
  reservationId?: string | null;
  roomId?: string | null;
  request?: unknown;
  response?: unknown;
  errorMessage?: string;
  attempt?: number;
  durationMs?: number;
};

/**
 * Beds24 kanalining id'si.
 *
 * KESHLANMAYDI: DB qayta seed qilinganda (testlar, reset) `Channel`
 * qatori qayta yaratiladi va id o'zgaradi — eski id bilan yozish
 * foreign key xatosiga tushib, jim yutilardi.
 */
async function getChannelId(): Promise<string> {
  const channel = await prisma.channel.upsert({
    where: { code: "beds24" },
    create: { code: "beds24", name: "Beds24" },
    update: {},
    select: { id: true },
  });
  return channel.id;
}

/**
 * SyncLog yozuvi yaratadi.
 *
 * `request` va `response` `sanitizeForLog` dan o'tadi — token,
 * parol, invite code kabi maydonlar logga tushmaydi (TZ 18-band).
 */
export async function logSync(input: SyncLogInput): Promise<void> {
  try {
    const channelId = await getChannelId();
    await prisma.syncLog.create({
      data: {
        channelId,
        action: input.action,
        direction: input.direction,
        status: input.status,
        reservationId: input.reservationId ?? null,
        roomId: input.roomId ?? null,
        request: input.request === undefined ? undefined : (sanitizeForLog(input.request) as Prisma.InputJsonValue),
        response: input.response === undefined ? undefined : (sanitizeForLog(input.response) as Prisma.InputJsonValue),
        errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
        attempt: input.attempt ?? 1,
        durationMs: input.durationMs ?? null,
      },
    });
  } catch (e) {
    // Log yozilmasa asosiy amal baribir bajarilgan (TZ 17-band)
    console.warn(`[synclog] yozilmadi: ${String(e).slice(0, 120)}`);
  }
}

/** PMS -> Beds24 yo'nalishi uchun qisqartma */
export const logPush = (
  action: string,
  status: SyncLogStatus,
  extra: Omit<SyncLogInput, "action" | "direction" | "status"> = {}
) => logSync({ action, direction: "PMS_TO_CHANNEL", status, ...extra });

/** Beds24 -> PMS yo'nalishi uchun qisqartma */
export const logPull = (
  action: string,
  status: SyncLogStatus,
  extra: Omit<SyncLogInput, "action" | "direction" | "status"> = {}
) => logSync({ action, direction: "CHANNEL_TO_PMS", status, ...extra });

// ============================================================
//  Jurnal qatorini odam o'qiydigan qilish (TZ 16-band)
// ============================================================

export type SyncLogView = {
  /** Xona yoki tarif (va Beds24 dagi mos xona turi) */
  target: string | null;
  /** Sana yoki oraliq */
  dates: string | null;
  /** Nima yuborildi / olindi: status, narx, son */
  value: string | null;
};

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

function range(from: unknown, to: unknown): string | null {
  const a = str(from);
  const b = str(to);
  if (!a) return null;
  return !b || a === b ? a : `${a} — ${b}`;
}

/**
 * TZ 16-band misolidagi maydonlar (Room, Date, Value) — `request` va
 * `response` JSON ichidan. Yozish paytida alohida ustun ochilmaydi:
 * eski yozuvlar ham shu bilan ko'rinadi.
 */
export function describeSyncLog(row: {
  action: string;
  roomId: string | null;
  request: unknown;
  response: unknown;
}): SyncLogView {
  const req = asObj(row.request) ?? {};
  const res = asObj(row.response) ?? {};

  // --- Xona / tarif ---
  const extIds = Array.isArray(req.externalRoomTypeIds)
    ? (req.externalRoomTypeIds as unknown[]).map(String)
    : str(req.externalRoomTypeId) ? [String(req.externalRoomTypeId)] : [];
  const ext = extIds.length
    ? ` → Beds24 ${extIds.join(", ")}${str(req.externalUnitId) ? `/${req.externalUnitId}` : ""}`
    : "";
  const target = str(req.roomTypeId)
    ? `Tarif ${req.roomTypeId}${ext}`
    : row.roomId
      ? `Xona ${row.roomId}${ext}`
      : str(req.externalId)
        ? `Beds24 #${req.externalId}`
        : ext ? ext.slice(3) : null;

  // --- Sana ---
  const dates = range(req.checkIn, req.checkOut) ?? range(req.from, req.to);

  // --- Qiymat ---
  let value: string | null = null;
  switch (row.action) {
    case "push_reservation":
      value = [str(req.status), str(req.totalPrice), str(res.externalId) ? `Beds24 #${res.externalId}` : null]
        .filter(Boolean).join(" · ") || null;
      break;
    case "push_rates": {
      const prices = Array.isArray(req.prices) ? (req.prices as unknown[]).map(String) : [];
      const parts = [
        prices.length ? `${prices.join(" / ")} ${str(req.currency) ?? ""}`.trim() : null,
        str(req.restrictions),
        str(req.days) ? `${req.days} kun` : null,
      ];
      value = parts.filter(Boolean).join(" · ") || null;
      break;
    }
    case "push_room_block":
      value = "yopildi";
      break;
    case "cancel_room_block":
      value = "ochildi";
      break;
    case "pull_rates":
      value = res.changed !== undefined ? `${res.changed} kun o'zgardi (${res.checked ?? 0} tekshirildi)` : str(res.detail);
      break;
    case "poll_bookings":
      value = res.fetched !== undefined
        ? `${res.fetched} bron: ${res.created ?? 0} yangi, ${res.updated ?? 0} yangilandi`
        : str(res.detail);
      break;
    case "drift_check":
    case "drift_detected":
      value = `${res.driftDays ?? 0} kun farq (${res.checkedDays ?? req.checkedDays ?? "?"} kun)`;
      break;
    default:
      value = str(res.detail) ?? (str(res.externalId) ? `Beds24 #${res.externalId}` : null);
  }

  return { target, dates, value: value ? value.slice(0, 200) : null };
}
