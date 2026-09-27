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
