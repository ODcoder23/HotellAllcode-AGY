/**
 * Availability keshi — tur x kun bo'yicha bo'sh xonalar soni
 *
 * Manba: 07-AVAILABILITY-VA-RATES-SYNC.md §1–§2
 * TZ 6-band:  "Xona band qilinsa availability kamayadi, bekor qilinsa
 *              qayta oshadi."
 *
 * IKKI DARAJA (07-fayl §1):
 *   aniq xona (101, 102, ...) — haqiqat manbai: bronlar va yopiq kunlar
 *   tur bo'yicha SON         — shu keshda, sayt qidiruvi uchun
 * Ikkinchisi birinchisidan hisoblab chiqariladi, qo'lda yozilmaydi.
 *
 * Kesh eskirsa ham overbooking bo'lmaydi: bron `reservation_no_overlap`
 * constraint va `isRoomFree` bilan himoyalangan. Kesh faqat saytda
 * "nechta xona bo'sh" ko'rsatadi.
 */

import { prisma } from "../lib/prisma.js";
import { toDateKey } from "../lib/serialize.js";
import { addDays, hotelToday } from "../lib/hotelTime.js";
import { notifyAvailability } from "../realtime/notify.js";

/** Bir turning bir kunlik holati */
export type AvailabilityDay = {
  date: string;            // "YYYY-MM-DD"
  availableCount: number;
  totalRooms: number;
};

// ============================================================
//  1. Qayta hisoblash (07-fayl §2 agregatsiya formulasi)
// ============================================================

/**
 * Availability'ni qayta hisoblaydi.
 *
 * TRANZAKSIYADAN TASHQARIDA chaqiriladi. Sabab: bu funksiya butun
 * room type bo'yicha o'qiydi, shuning uchun `Serializable` tranzaksiya
 * ichida bo'lsa — turli xonalarga parallel bron ham konflikt beradi
 * (ikkalasi bir xil `Availability` sahifalariga tegadi).
 *
 * SOTUVDAGI XONA = faol va ta'mirda emas (`OUT_OF_ORDER`,
 * `OUT_OF_SERVICE` emas). Sayt xonani aynan shu qoida bilan tanlaydi
 * (`publicBooking.ts` `pickRoom`). 2026-09-26 gacha kesh ta'mirdagi
 * xonani ham "bo'sh" deb sanardi: sayt "1 xona bor" derdi, bron esa
 * "bo'sh xona qolmadi" bilan rad etilardi.
 *
 * Bitta SQL so'rov bilan bajariladi — N+1 dan qochish uchun.
 */
export async function recalcAvailability(
  roomTypeIds: string[],
  from: Date,
  to: Date
): Promise<void> {
  if (roomTypeIds.length === 0 || to <= from) return;

  await prisma.$executeRaw`
    INSERT INTO "Availability" (
      id, "roomTypeId", date, "totalRooms", "bookedRooms",
      "blockedRooms", "availableCount", "updatedAt"
    )
    SELECT
      gen_random_uuid()::text,
      rt.id,
      d.date::date,
      rt.total,
      COALESCE(b.cnt, 0),
      COALESCE(bl.cnt, 0),
      GREATEST(0, rt.total - COALESCE(b.cnt, 0) - COALESCE(bl.cnt, 0)),
      NOW()
    FROM (
      SELECT t.id, COUNT(r.id)::int AS total
      FROM "RoomType" t
      LEFT JOIN "Room" r ON r."roomTypeId" = t.id AND r."isActive" = true
        AND r.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      WHERE t.id = ANY(${roomTypeIds})
      GROUP BY t.id
    ) rt
    CROSS JOIN generate_series(${from}::date, ${to}::date - 1, '1 day') AS d(date)
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT res."roomId")::int AS cnt
      FROM "Reservation" res
      JOIN "Room" rm ON rm.id = res."roomId"
      WHERE rm."roomTypeId" = rt.id
        AND rm."isActive" = true
        AND rm.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
        AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
        AND res."checkIn" <= d.date
        AND res."checkOut" > d.date
    ) b ON true
    LEFT JOIN LATERAL (
      -- Shu kuni yopiq, lekin bron bilan band bo'lmagan xonalar
      -- (majburan yopilgan band xona ikki marta ayirilmasin)
      SELECT COUNT(*)::int AS cnt
      FROM "RoomDayStatus" rds
      JOIN "Room" rm ON rm.id = rds."roomId"
      WHERE rm."roomTypeId" = rt.id
        AND rm."isActive" = true
        AND rm.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
        AND rds.date = d.date
        AND rds."isBlocked" = true
        AND NOT EXISTS (
          SELECT 1 FROM "Reservation" res
          WHERE res."roomId" = rds."roomId"
            AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
            AND res."checkIn" <= d.date
            AND res."checkOut" > d.date
        )
    ) bl ON true
    ON CONFLICT ("roomTypeId", date) DO UPDATE SET
      "totalRooms"     = EXCLUDED."totalRooms",
      "bookedRooms"    = EXCLUDED."bookedRooms",
      "blockedRooms"   = EXCLUDED."blockedRooms",
      "availableCount" = EXCLUDED."availableCount",
      "updatedAt"      = NOW()
  `;
}

// ============================================================
//  2. Oraliqni o'qish
// ============================================================

/**
 * Oraliqdagi kunlarni qaytaradi (keshdan, qayta hisoblamaydi).
 *
 * `to` CHIQMAYDI: `'[)'` chegara qoidasi (02-fayl §4). Mehmon
 * checkOut kuni xonada yo'q, ya'ni o'sha kun band emas.
 */
export async function readRange(
  roomTypeId: string,
  from: Date,
  to: Date
): Promise<AvailabilityDay[]> {
  const rows = await prisma.availability.findMany({
    where: {
      roomTypeId,
      date: { gte: from, lt: to },
    },
    orderBy: { date: "asc" },
  });

  return rows.map((r) => ({
    date: toDateKey(r.date) ?? "",
    availableCount: r.availableCount,
    totalRooms: r.totalRooms,
  }));
}

/** Bir turning oraliqdagi holati — admin paneldagi "Mavjudlik" jadvali */
export type AvailabilityGridRow = {
  roomTypeId: string;
  label: string;
  days: AvailabilityDay[];
};

/**
 * Hamma turlar x kunlar jadvali, avval keshni YANGILAB.
 *
 * Admin paneldagi "Mavjudlik" sahifasi uchun. 2026-09-26 gacha u
 * sahifa qattiq yozilgan 3 tarif va tasodifiy sonlar ko'rsatardi —
 * qabulxona unga qarab "xona bor" deyishi mumkin edi. Endi sayt
 * qidiruvi bilan bir xil manba: shu kesh va shu formula.
 *
 * Qayta hisoblash bitta SQL (tur soni x kun) — 9 tur x 31 kun arzon.
 */
export async function availabilityGrid(from: Date, to: Date): Promise<AvailabilityGridRow[]> {
  const types = await prisma.roomType.findMany({
    orderBy: { sortOrder: "asc" },
    select: { id: true, label: true },
  });
  const ids = types.map((t) => t.id);
  await recalcAvailability(ids, from, to);

  const rows = await prisma.availability.findMany({
    where: { roomTypeId: { in: ids }, date: { gte: from, lt: to } },
    orderBy: { date: "asc" },
  });
  const byType = new Map<string, AvailabilityDay[]>(ids.map((id) => [id, []]));
  for (const r of rows) {
    byType.get(r.roomTypeId)?.push({
      date: toDateKey(r.date) ?? "",
      availableCount: r.availableCount,
      totalRooms: r.totalRooms,
    });
  }
  return types.map((t) => ({ roomTypeId: t.id, label: t.label, days: byType.get(t.id) ?? [] }));
}

// ============================================================
//  3. O'zgarish hodisasi (bron, yopish, STOP amallaridan)
// ============================================================

/**
 * Bron yoki yopish o'zgarganda chaqiriladi: kesh + WebSocket.
 *
 * TARTIB: avval DB'dagi son to'g'ri bo'ladi, keyin sayt va admin
 * panel xabar oladi.
 */
export async function onAvailabilityChanged(
  roomTypeIds: string[],
  from: Date,
  to: Date,
  _reason: string
): Promise<void> {
  if (roomTypeIds.length === 0) return;

  await recalcAvailability(roomTypeIds, from, to);
  notifyAvailability(roomTypeIds, from, to);
}

/**
 * Tur uchun sayt sotadigan butun oraliq (bugundan 1 yil) — xona
 * inventardan chiqqanda yoki ta'mirga qo'yilganda.
 */
export async function recalcTypeHorizon(roomTypeIds: string[]): Promise<void> {
  const today = hotelToday();
  await onAvailabilityChanged(roomTypeIds, today, addDays(today, 367), "room_status");
}
