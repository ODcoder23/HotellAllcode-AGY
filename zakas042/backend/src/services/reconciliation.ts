/**
 * Polling, farq (drift) tekshiruvi va catch-up — TZ 10, 17, 20-band
 *
 *   POLLING   — webhook yetib kelmagan bronlarni tutib oladi (15 daqiqa)
 *   DRIFT     — PMS va Beds24 bo'sh joyini solishtiradi (kunlik, faqat qayd)
 *   CATCH-UP  — Beds24 yoki Redis o'chib turganda yuborilmay qolganlarni
 *               yuboradi (TZ 17-band: "Beds24 qayta ishlaganda avtomatik
 *               yuborilsin")
 *
 * Asosiy oqim emas — asosiy oqim real-time webhook va darhol navbatga
 * qo'yiladigan sync. Bular "tutib olish to'ri".
 */

import { prisma } from "../lib/prisma.js";
import { toDateKey } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import { logPull, logPush } from "../lib/syncLog.js";
import { getChannel } from "./channel/registry.js";
import { applyReservation, processPendingEvents } from "./webhookProcessor.js";
import { resyncPending } from "./reservationSync.js";
import { syncAllRoomBlocks } from "./channelBlocks.js";
import { findRoomTypeMapping } from "./mapping.js";
import { recalcAvailability, readRange } from "./availability.js";
import { activeConnection, getBeds24Channel, recordCheck } from "./beds24/auth.js";
import { notifySyncFailed } from "../realtime/notify.js";

const KEY_BOOKINGS_PULL = "bookings_pull";

// ============================================================
//  1. Polling (TZ 10-band)
// ============================================================

export type PollResult = {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  needsAction: number;
  /** Birinchi (to'liq) importmi */
  full: boolean;
  since: string | null;
};

/**
 * Beds24'dan bronlarni tortib oladi va PMS'ga qo'llaydi.
 *
 * BIRINCHI YURISH TO'LIQ (2026-09-27): ulanishdan oldin kelgan OTA
 * bronlari ham PMS'ga tushishi kerak — `departureFrom = bugun` bilan
 * hozirgi va kelgusi HAMMA bronlar olinadi. Ilgari faqat oxirgi 24
 * soatda o'zgarganlar olinardi va eski bronlar PMS'ga hech qachon
 * tushmasdi (sayt o'sha kunlarni sotishi mumkin edi). Keyingi yurishlar
 * faqat O'ZGARGANLARNI so'raydi (`modifiedFrom`) — kredit tejaladi.
 *
 * KOD TAKRORLANMAYDI: har bron `applyReservation` orqali — webhook
 * worker'i ham aynan shuni chaqiradi.
 *
 * VAQT OLDINDAN OLINADI: so'rov yuborilgan payt qayd etiladi, javob
 * kelgani emas — so'rov davomida o'zgargan bron o'tkazib yuborilmasin.
 */
export async function pollBookings(opts: { full?: boolean } = {}): Promise<PollResult> {
  const started = new Date();
  const empty = { fetched: 0, created: 0, updated: 0, skipped: 0, needsAction: 0, full: false, since: null };
  if (!(await activeConnection())) return empty;

  const channel = await getBeds24Channel();

  // Birorta ham bog'lanish yo'q (hozirgina ulandi) — polling kutadi:
  // aks holda har Beds24 broni "bog'lanmagan" bo'lib qolar va birinchi
  // (to'liq) import behuda ketardi. Bog'langanda to'liq import qayta
  // ishga tushadi (routes/channel.ts)
  const mapped = await prisma.channelMapping.count({ where: { channelId: channel.id, isActive: true } });
  if (mapped === 0) {
    await logPull("poll_bookings", "SKIPPED", { response: { detail: "xonalar Beds24 bilan bog'lanmagan — polling kutadi" } });
    return empty;
  }
  const state = await prisma.syncState.findUnique({
    where: { channelId_key: { channelId: channel.id, key: KEY_BOOKINGS_PULL } },
  });
  const full = opts.full === true || !state?.lastSuccessfulAt;
  // Kichik ustma-ustlik: chegarada turgan bron o'tkazib yuborilmasin
  const since = full ? null : new Date(state!.lastSuccessfulAt!.getTime() - 2 * 60_000);

  const counts = { fetched: 0, created: 0, updated: 0, skipped: 0, needsAction: 0 };
  try {
    const list = full
      ? await getChannel().pullActiveReservations(toDateKey(hotelToday()) ?? "")
      : await getChannel().pullReservations(since!);
    counts.fetched = list.length;

    for (const ext of list) {
      try {
        const result = await applyReservation(ext);
        if (result.status === "processed") {
          if (result.created) counts.created++;
          else counts.updated++;
        } else if (result.status === "needs_manual_action") {
          counts.needsAction++;
          await logPull("poll_needs_action", "FAILED", {
            reservationId: result.reservationId,
            request: { externalId: ext.externalId },
            errorMessage: result.detail,
          });
          notifySyncFailed("poll_bookings", result.detail, result.reservationId, {
            telegram: result.problem !== "no_mapping",
          });
        } else {
          counts.skipped++;
        }
      } catch (e) {
        // Bitta bron yiqilsa qolganlari davom etadi (TZ 17-band)
        counts.skipped++;
        console.warn(`[poll] bron ${ext.externalId}: ${String(e).slice(0, 120)}`);
      }
    }

    // Faqat muvaffaqiyatli yurishdan keyin — xato bo'lsa keyingi safar
    // o'sha oraliq qayta so'raladi
    await prisma.syncState.upsert({
      where: { channelId_key: { channelId: channel.id, key: KEY_BOOKINGS_PULL } },
      create: { channelId: channel.id, key: KEY_BOOKINGS_PULL, lastSuccessfulAt: started },
      update: { lastSuccessfulAt: started },
    });
    await logPull("poll_bookings", "SUCCESS", { response: { ...counts, full } });
  } catch (e) {
    await logPull("poll_bookings", "FAILED", { errorMessage: String(e instanceof Error ? e.message : e).slice(0, 300) });
    throw e;
  }

  return { ...counts, full, since: since?.toISOString() ?? null };
}

// ============================================================
//  2. Drift tekshiruvi (TZ 20-band)
// ============================================================

export type DriftDay = { roomTypeId: string; date: string; pms: number; beds24: number };

export type DriftResult = {
  checkedDays: number;
  driftDays: number;
  details: DriftDay[];
};

/**
 * PMS va Beds24 bo'sh joyini solishtiradi — FAQAT QAYD ETADI.
 *
 * Beds24 ustuvor (Q9): bo'sh joy sonini Beds24 bronlardan o'zi
 * hisoblaydi, PMS son yozmaydi. Farq odatda sozlamani ko'rsatadi:
 * xona soni mos emas (Beds24'da 1 unit, PMS'da 3 xona), bog'lanmagan
 * xona, Beds24'ga yetmagan bron. Admin ko'radi va hal qiladi.
 *
 * Faqat TUR darajasidagi bog'lanishlar solishtiriladi (xona darajasida
 * Beds24 turi = bitta xona, PMS tarifida esa bir nechta).
 */
export async function checkDrift(daysAhead = 30): Promise<DriftResult> {
  if (!(await activeConnection())) return { checkedDays: 0, driftDays: 0, details: [] };

  const from = hotelToday();
  const to = addDays(from, daysAhead);
  const fromKey = toDateKey(from) ?? "";
  const toKey = toDateKey(addDays(to, -1)) ?? "";

  const types = await prisma.roomType.findMany({ select: { id: true } });
  const details: DriftDay[] = [];
  let checkedDays = 0;

  for (const type of types) {
    const mapping = await findRoomTypeMapping(type.id);
    if (!mapping?.externalRoomTypeId) continue;

    await recalcAvailability([type.id], from, to);
    const pmsByDate = new Map((await readRange(type.id, from, to)).map((d) => [d.date, d.availableCount]));

    let remote: Array<{ date: string; available: number }>;
    try {
      remote = await getChannel().getAvailability(mapping.externalRoomTypeId, fromKey, toKey);
    } catch (e) {
      console.warn(`[drift] ${type.id} o'qilmadi: ${String(e).slice(0, 100)}`);
      continue;
    }

    for (const r of remote) {
      const pms = pmsByDate.get(r.date);
      if (pms === undefined) continue;
      checkedDays++;
      if (pms !== r.available) details.push({ roomTypeId: type.id, date: r.date, pms, beds24: r.available });
    }
  }

  if (details.length > 0) {
    await logPush("drift_detected", "FAILED", {
      request: { checkedDays },
      response: { driftDays: details.length, sample: details.slice(0, 20) },
      errorMessage: `${details.length} kunda PMS va Beds24 bo'sh joyi farq qiladi`,
    });
    notifySyncFailed("drift_detected", `${details.length} kunda PMS va Beds24 bo'sh joyi farq qiladi`);
  } else {
    await logPush("drift_check", "SUCCESS", { response: { checkedDays, driftDays: 0 } });
  }
  return { checkedDays, driftDays: details.length, details };
}

// ============================================================
//  3. Catch-up (TZ 17-band)
// ============================================================

export type CatchUpResult = {
  webhooks: number;
  reservations: { total: number; sent: number; failed: number; rejected: number };
  blocks: { rooms: number; created: number; cancelled: number; failed: number };
};

/**
 * Yuborilmay qolgan ishlarni yuboradi: navbatga tushmay qolgan webhook,
 * FAILED / eski PENDING bronlar, Beds24'ga yetmagan xona yopilishlari.
 * REJECTED bronlar kirmaydi (reservationSync.ts).
 */
export async function catchUpPending(): Promise<CatchUpResult> {
  const webhooks = await processPendingEvents(100);
  if (!(await activeConnection())) {
    return {
      webhooks: webhooks.processed,
      reservations: { total: 0, sent: 0, failed: 0, rejected: 0 },
      blocks: { rooms: 0, created: 0, cancelled: 0, failed: 0 },
    };
  }
  const reservations = await resyncPending(100);
  const blocks = await syncAllRoomBlocks().catch((e) => {
    console.warn(`[catch-up] xona yopish sinxroni: ${String(e).slice(0, 150)}`);
    return { rooms: 0, created: 0, cancelled: 0, failed: 0 };
  });
  return { webhooks: webhooks.processed, reservations, blocks };
}

// ============================================================
//  4. Ulanishni tekshirish
// ============================================================

/**
 * "Ulanishni tekshirish": obyekt, xona turlari, token ruxsatlari.
 * Natija ulanish yozuviga yoziladi — panel oxirgi holatni ko'rsatadi.
 */
export async function pingChannel() {
  if (!(await activeConnection())) return { ok: false, detail: "Beds24 ulanmagan" };
  const ping = await getChannel().ping();
  const scopes = ping.ok ? await getChannel().getTokenScopes().catch(() => undefined) : undefined;
  await recordCheck(ping.ok, ping.ok ? null : ping.detail, scopes);
  await logPull("ping", ping.ok ? "SUCCESS" : "FAILED", {
    response: ping.ok ? { detail: ping.detail, scopes } : undefined,
    errorMessage: ping.ok ? undefined : ping.detail,
  });
  return { ...ping, scopes: scopes ?? [] };
}
