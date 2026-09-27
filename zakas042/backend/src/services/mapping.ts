/**
 * Xona mapping — TZ 5-band, "Eng muhim qism"
 *
 * TZ: "Har bir mapping database'da saqlansin.
 *      Noto'g'ri xona turiga bron tushmasligi kerak."
 *
 * Ikki daraja:
 *   tur  — Beds24 xona turi (roomId) -> PMS tarif (RoomType)
 *   unit — Beds24 roomId + unitId -> PMS xona (Room). Unit id har
 *          turda 1 dan boshlanadi, shuning uchun faqat roomId bilan
 *          birga noyob (real API)
 *
 * QAT'IY QOIDA: mapping topilmasa sync RAD ETILADI. Taxminiy mapping —
 * na "eng yaqin tur", na "birinchi topilgan" — ASLO ishlatilmaydi.
 * Noto'g'ri xonaga tushgan bron real overbooking keltiradi.
 */

import { prisma } from "../lib/prisma.js";
import { AppError, NotFoundError, ValidationError } from "../lib/errors.js";
import { hotelToday } from "../lib/hotelTime.js";
import { getRoomTypesCached } from "./channel/propertyCache.js";
import type { ExternalProperty } from "./channel/types.js";
import { activeConnection, getBeds24Channel } from "./beds24/auth.js";

// ============================================================
//  Beds24 obyekti (kesh — propertyCache.ts)
// ============================================================

/** Ulangan obyekt va uning xona turlari */
export async function getExternalProperty(force = false): Promise<ExternalProperty> {
  if (!(await activeConnection())) throw new ValidationError("Beds24 ulanmagan");
  const props = await getRoomTypesCached(undefined, { force });
  const prop = props[0];
  if (!prop) throw new ValidationError("Beds24 hisobida ulangan obyekt topilmadi — qayta ulang");
  return prop;
}

// ============================================================
//  O'qish
// ============================================================

export async function listMappings() {
  const channel = await getBeds24Channel();
  const rows = await prisma.channelMapping.findMany({
    where: { channelId: channel.id, isActive: true },
    include: {
      roomType: { select: { id: true, label: true } },
      room: { select: { id: true, number: true, roomTypeId: true } },
    },
    orderBy: [{ externalRoomTypeId: "asc" }, { externalUnitId: "asc" }],
  });
  return rows.map((m) => ({
    id: m.id,
    externalPropertyId: m.externalPropertyId,
    externalRoomTypeId: m.externalRoomTypeId,
    externalUnitId: m.externalUnitId,
    externalName: m.externalName,
    roomTypeId: m.roomTypeId ?? m.room?.roomTypeId ?? null,
    roomTypeLabel: m.roomType?.label ?? null,
    roomId: m.roomId,
    roomNumber: m.room?.number ?? null,
    includesMeal: m.includesMeal,
    level: m.roomId ? ("unit" as const) : ("type" as const),
  }));
}

export type MappingRow = Awaited<ReturnType<typeof listMappings>>[number];

/**
 * PMS tarifi uchun tur darajasidagi mapping. Sync operatsiyalari shu
 * funksiyani chaqiradi — `null` qaytsa sync bajarilmaydi.
 */
export async function findRoomTypeMapping(roomTypeId: string) {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return null;
  return prisma.channelMapping.findFirst({
    where: { channelId: channel.id, roomTypeId, roomId: null, isActive: true },
  });
}

/**
 * Xona (unit) darajasidagi mapping — PMS xonasi Beds24'dagi qaysi
 * unit ekani. Xona almashtirilsa Beds24'da ham o'sha unit ko'rinadi (Q6).
 */
export async function findRoomMapping(roomId: string) {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return null;
  return prisma.channelMapping.findFirst({
    where: { channelId: channel.id, roomId, isActive: true, externalUnitId: { not: null } },
  });
}

/**
 * Tashqi room type (+ unit) bo'yicha PMS tomonini topadi (webhook,
 * polling). Avval aniq unit, keyin tur darajasi.
 *
 * `externalRoomTypeId` HAM shart: Beds24'da unit id har xona turida
 * 1 dan boshlanadi — faqat unit bo'yicha qidirilsa boshqa turdagi bron
 * shu xonaga tushib qolardi.
 */
export async function findByExternal(externalRoomTypeId: string, externalUnitId?: string) {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return null;

  if (externalUnitId) {
    const unitMapping = await prisma.channelMapping.findFirst({
      where: { channelId: channel.id, externalRoomTypeId, externalUnitId, isActive: true, roomId: { not: null } },
      include: { room: true, roomType: true },
    });
    if (unitMapping) return unitMapping;
  }

  const typeMapping = await prisma.channelMapping.findFirst({
    where: { channelId: channel.id, externalRoomTypeId, externalUnitId: null, isActive: true },
    include: { room: true, roomType: true },
  });
  if (typeMapping) return typeMapping;

  // Beds24'da har "Room" bitta xona (real hisob: Room 1 = 101) va unit
  // id bron'da kelmagan bo'lishi mumkin — shu turdagi YAGONA unit
  // bog'lanishi aniq xonani bildiradi
  const units = await prisma.channelMapping.findMany({
    where: { channelId: channel.id, externalRoomTypeId, isActive: true, roomId: { not: null } },
    include: { room: true, roomType: true },
    take: 2,
  });
  return units.length === 1 ? units[0] : null;
}

// ============================================================
//  To'liqlik (panel ogohlantirishi)
// ============================================================

/**
 * Bog'lanish to'liqligi.
 *
 * To'liq = har faol PMS xonasi Beds24 unit'iga YOKI uning tarifi Beds24
 * turiga bog'langan. Bog'lanmagan xonalar bronlari Beds24'ga ketmaydi
 * (OTA ularni sotmaydi, PMS esa sotadi — bu normal holat bo'lishi mumkin).
 */
export async function mappingHealth() {
  const [mappings, rooms, types] = await Promise.all([
    listMappings(),
    prisma.room.findMany({ where: { isActive: true }, select: { id: true, roomTypeId: true } }),
    prisma.roomType.findMany({ select: { id: true, label: true } }),
  ]);
  const typeMapped = new Set(mappings.filter((m) => m.level === "type").map((m) => m.roomTypeId));
  const roomMapped = new Set(mappings.filter((m) => m.roomId).map((m) => m.roomId));

  const unmappedRooms = rooms.filter((r) => !roomMapped.has(r.id) && !typeMapped.has(r.roomTypeId)).map((r) => r.id);
  const unmappedTypes = types.filter((t) => !typeMapped.has(t.id) && !mappings.some((m) => m.roomTypeId === t.id)).map((t) => t.id);

  return {
    total: mappings.length,
    typeLevel: mappings.filter((m) => m.level === "type").length,
    unitLevel: mappings.filter((m) => m.level === "unit").length,
    roomsTotal: rooms.length,
    roomsMapped: rooms.length - unmappedRooms.length,
    unmappedRooms,
    unmappedTypes,
    isComplete: mappings.length > 0 && unmappedRooms.length === 0,
  };
}

// ============================================================
//  Yozish (faqat PMS bazasida)
// ============================================================

export type MappingInput = {
  externalRoomTypeId: string;
  externalUnitId?: string | null;
  externalName?: string | null;
  roomTypeId?: string | null;
  roomId?: string | null;
  includesMeal?: boolean;
};

export async function upsertMapping(input: MappingInput) {
  const channel = await getBeds24Channel();
  const unitId = input.externalUnitId?.trim() || null;

  if (unitId && !input.roomId) throw new ValidationError("Unit bog'lanishi uchun PMS xonasi (roomId) kerak");
  if (!unitId && !input.roomTypeId) throw new ValidationError("Tur bog'lanishi uchun PMS tarifi (roomTypeId) kerak");

  if (input.roomId) {
    const room = await prisma.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new NotFoundError(`Xona ${input.roomId}`);
  }
  if (input.roomTypeId) {
    const type = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
    if (!type) throw new NotFoundError(`Tarif ${input.roomTypeId}`);
  }

  // `externalUnitId` NULL bo'lganda unique indeks takrorni ushlamaydi
  // (PostgreSQL'da NULL'lar teng emas) — shuning uchun avval qidiramiz
  const existing = await prisma.channelMapping.findFirst({
    where: { channelId: channel.id, externalRoomTypeId: input.externalRoomTypeId, externalUnitId: unitId },
  });

  // Bir PMS xonasi faqat bitta Beds24 unit'iga; bir PMS tarifi faqat
  // bitta Beds24 turiga (tur darajasi) — aks holda bron qaysi turga
  // ketishi noaniq bo'lardi
  if (input.roomId) {
    await prisma.channelMapping.deleteMany({
      where: { channelId: channel.id, roomId: input.roomId, NOT: existing ? { id: existing.id } : undefined },
    });
  } else if (input.roomTypeId) {
    await prisma.channelMapping.deleteMany({
      where: {
        channelId: channel.id, roomTypeId: input.roomTypeId, roomId: null,
        NOT: existing ? { id: existing.id } : undefined,
      },
    });
  }

  // TZ 11-band: bog'lanish qaysi Beds24 obyektiga tegishli
  const conn = await activeConnection();
  const data = {
    roomTypeId: unitId ? null : input.roomTypeId ?? null,
    roomId: unitId ? input.roomId ?? null : null,
    externalName: input.externalName ?? existing?.externalName ?? null,
    includesMeal: input.includesMeal ?? existing?.includesMeal ?? false,
    externalPropertyId: conn?.propertyId ?? existing?.externalPropertyId ?? null,
    isActive: true,
  };

  const row = existing
    ? await prisma.channelMapping.update({ where: { id: existing.id }, data })
    : await prisma.channelMapping.create({
        data: { channelId: channel.id, externalRoomTypeId: input.externalRoomTypeId, externalUnitId: unitId, ...data },
      });
  return { row, created: !existing };
}

/**
 * Mapping o'chiradi.
 *
 * Faol bronlar bo'lsa `force` so'raladi: o'chirilsa ular Beds24 bilan
 * sinxronlanmay qoladi (xona almashsa, bekor qilinsa Beds24 bilmaydi).
 */
export async function deleteMapping(id: string, opts: { force?: boolean } = {}) {
  const row = await prisma.channelMapping.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Bog'lanish");

  const activeCount = await prisma.reservation.count({
    where: {
      status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] },
      externalReservationId: { not: null },
      ...(row.roomId
        ? { roomId: row.roomId }
        : row.roomTypeId
          ? { room: { roomTypeId: row.roomTypeId } }
          : {}),
    },
  });
  if (activeCount > 0 && !opts.force) {
    throw new AppError(
      409,
      `Bu bog'lanish bo'yicha Beds24'dagi ${activeCount} ta faol bron bor — ` +
      `o'chirilsa ular Beds24 bilan sinxronlanmay qoladi. Baribir o'chirilsinmi?`,
      "MAPPING_HAS_ACTIVE_RESERVATIONS"
    );
  }

  await prisma.channelMapping.delete({ where: { id } });
  return { row, activeReservations: activeCount };
}

export async function setMappingMeal(id: string, includesMeal: boolean) {
  const row = await prisma.channelMapping.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Bog'lanish");
  return prisma.channelMapping.update({ where: { id }, data: { includesMeal } });
}

/**
 * Unit'larni avtomatik bog'lash: Beds24 unit nomi = PMS xona raqami
 * ("101"). Mos kelmaganlar ro'yxat bilan qaytadi — qo'lda bog'lanadi.
 */
export async function autoMapUnits() {
  const prop = await getExternalProperty(true);
  const rooms = await prisma.room.findMany({ where: { isActive: true }, select: { id: true, number: true } });
  const byNumber = new Map(rooms.map((r) => [r.number, r.id]));

  const mapped: Array<{ externalRoomTypeId: string; externalUnitId: string; roomId: string }> = [];
  const skipped: Array<{ externalRoomTypeId: string; externalUnitId: string; unitName: string }> = [];

  for (const rt of prop.roomTypes) {
    for (const u of rt.units) {
      const roomId = byNumber.get(u.name.trim());
      if (!roomId) {
        skipped.push({ externalRoomTypeId: rt.id, externalUnitId: u.id, unitName: u.name });
        continue;
      }
      await upsertMapping({ externalRoomTypeId: rt.id, externalUnitId: u.id, roomId, externalName: `${rt.name} / ${u.name}` });
      mapped.push({ externalRoomTypeId: rt.id, externalUnitId: u.id, roomId });
    }
  }
  return { mapped, skipped };
}

/**
 * Bog'lanishlarni ulangan obyektga moslaydi (TZ 11-band) — ulash yoki
 * obyekt almashtirilgandan keyin chaqiriladi.
 *
 *   - boshqa obyektniki — nofaol (Beds24 xona id'lari boshqa obyektda
 *     boshqa xonani bildiradi: bron noto'g'ri xonaga tushardi)
 *   - shu obyektniki (ilgari almashtirilganda o'chgan) — qayta faol
 *   - obyekti noma'lum (eski yozuv) — shu obyektga yoziladi
 *
 * Obyekt almashgan bo'lsa bronlar kursori tashlanadi — keyingi polling
 * yangi obyektning hamma bronlarini to'liq o'qiydi.
 */
export async function alignMappingsToProperty(propertyId: string): Promise<{ deactivated: number; reactivated: number }> {
  const channel = await getBeds24Channel();
  const [deactivated, reactivated] = await prisma.$transaction([
    prisma.channelMapping.updateMany({
      where: { channelId: channel.id, isActive: true, externalPropertyId: { not: null }, NOT: { externalPropertyId: propertyId } },
      data: { isActive: false },
    }),
    prisma.channelMapping.updateMany({
      where: { channelId: channel.id, isActive: false, externalPropertyId: propertyId },
      data: { isActive: true },
    }),
    prisma.channelMapping.updateMany({
      where: { channelId: channel.id, externalPropertyId: null },
      data: { externalPropertyId: propertyId },
    }),
  ]);
  if (deactivated.count > 0 || reactivated.count > 0) {
    // reconciliation.ts `KEY_BOOKINGS_PULL`
    await prisma.syncState.deleteMany({ where: { channelId: channel.id, key: "bookings_pull" } });
  }
  return { deactivated: deactivated.count, reactivated: reactivated.count };
}

/**
 * Mapping o'zgargandan (yoki qayta ulangandan) keyin: Beds24'ga hali
 * yetmagan faol bronlar darhol navbatga qo'yiladi — OTA shu xonani
 * sotmasin:
 *   - NOT_APPLICABLE — bog'lanmaganligi uchun yuborilmagan
 *   - PENDING / FAILED — Beds24 ulanmagan paytda yaratilgan (masalan
 *     xonadagi mehmon). Ilgari ular catch-up'ni (15 daqiqagacha)
 *     kutardi va shu orada Beds24 band xonani sotishi mumkin edi
 * REJECTED kirmaydi — avtomatik qayta yuborilmaydi (reservationSync.ts).
 *
 * Qaytaradi: navbatga qo'yilgan bronlar soni.
 */
export async function requeueAfterMappingChange(): Promise<number> {
  const rows = await prisma.reservation.findMany({
    where: {
      syncStatus: { in: ["NOT_APPLICABLE", "PENDING", "FAILED"] },
      status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] },
      checkOut: { gt: hotelToday() },
    },
    select: { id: true },
    take: 500,
  });
  if (rows.length === 0) return 0;

  const { onReservationChanged } = await import("./reservationSync.js");
  for (const r of rows) await onReservationChanged(r.id, "updated");
  return rows.length;
}
