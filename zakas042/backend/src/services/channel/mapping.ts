/**
 * Beds24 <-> PMS bog'lanishi (mapping) — kanal kuzatuvi uchun.
 *
 * Kuzatuvda mapping faqat SOLISHTIRISHGA kerak: Beds24 broni qaysi PMS
 * xonasiga to'g'ri kelishi, Beds24 narxi qaysi tarif narxi bilan
 * solishtirilishi. Hech narsa Beds24'ga yuborilmaydi.
 *
 * Ikki daraja:
 *   tur    — Beds24 xona turi (roomId) -> PMS tarif (RoomType)
 *   unit   — Beds24 roomId + unitId -> PMS xona (Room). Unit id har
 *            turda 1 dan boshlanadi, shuning uchun faqat roomId bilan
 *            birga noyob (BEDS24.md)
 */

import { prisma } from "../../lib/prisma.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getBeds24Channel, activeConnection } from "../beds24/client.js";
import { getProperties, type ExternalProperty } from "../beds24/api.js";

// ============================================================
//  Beds24 xonalari ro'yxati (kesh, 10 daqiqa)
// ============================================================

const TTL_MS = Number(process.env.PROPERTY_CACHE_TTL_MS ?? 10 * 60_000);
let cache: { at: number; propertyId: string; data: ExternalProperty } | null = null;

/** Faol ulanishdagi obyekt va uning xona turlari */
export async function getExternalProperty(force = false): Promise<ExternalProperty> {
  const conn = await activeConnection();
  if (!conn) throw new ValidationError("Beds24 ulanmagan");

  if (!force && cache && cache.propertyId === conn.propertyId && Date.now() - cache.at < TTL_MS) {
    return cache.data;
  }
  const all = await getProperties();
  // Boshqa obyektga jimgina o'tib ketmaslik: ID aniq mos kelishi shart
  const prop = all.find((p) => p.id === conn.propertyId);
  if (!prop) {
    throw new ValidationError(
      `Beds24 hisobida ${conn.propertyId} obyekti topilmadi (bor: ${all.map((p) => p.id).join(", ") || "—"})`
    );
  }
  cache = { at: Date.now(), propertyId: conn.propertyId, data: prop };
  return prop;
}

export function invalidatePropertyCache(): void {
  cache = null;
}

// ============================================================
//  O'qish
// ============================================================

export async function listMappings() {
  const channel = await getBeds24Channel();
  const rows = await prisma.channelMapping.findMany({
    where: { channelId: channel.id, isActive: true },
    include: { roomType: { select: { id: true, label: true } }, room: { select: { id: true, number: true, roomTypeId: true } } },
    orderBy: [{ externalRoomTypeId: "asc" }, { externalUnitId: "asc" }],
  });
  return rows.map((m) => ({
    id: m.id,
    externalRoomTypeId: m.externalRoomTypeId,
    externalUnitId: m.externalUnitId,
    externalName: m.externalName,
    roomTypeId: m.roomTypeId ?? m.room?.roomTypeId ?? null,
    roomTypeLabel: m.roomType?.label ?? null,
    roomId: m.roomId,
    roomNumber: m.room?.number ?? null,
    includesMeal: m.includesMeal,
    level: m.roomId ? "unit" : "type",
  }));
}

export type MappingRow = Awaited<ReturnType<typeof listMappings>>[number];

/**
 * Bog'lanish to'liqligi.
 *
 * To'liq = har faol PMS xonasi Beds24 unit'iga YOKI uning tarifi Beds24
 * turiga bog'langan. Bog'lanmagan xonalar bronini solishtirib bo'lmaydi.
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
    if (!room) throw new NotFoundError("Xona");
  }
  if (input.roomTypeId) {
    const type = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
    if (!type) throw new NotFoundError("Tarif");
  }

  // `externalUnitId` NULL bo'lganda unique indeks takrorni ushlamaydi
  // (PostgreSQL'da NULL'lar teng emas) — shuning uchun avval qidiramiz
  const existing = await prisma.channelMapping.findFirst({
    where: { channelId: channel.id, externalRoomTypeId: input.externalRoomTypeId, externalUnitId: unitId },
  });

  // Bir PMS xonasi faqat bitta Beds24 unit'iga
  if (input.roomId) {
    await prisma.channelMapping.deleteMany({
      where: { channelId: channel.id, roomId: input.roomId, NOT: existing ? { id: existing.id } : undefined },
    });
  }

  const data = {
    roomTypeId: unitId ? null : input.roomTypeId ?? null,
    roomId: unitId ? input.roomId ?? null : null,
    externalName: input.externalName ?? existing?.externalName ?? null,
    includesMeal: input.includesMeal ?? existing?.includesMeal ?? false,
    isActive: true,
  };

  return existing
    ? prisma.channelMapping.update({ where: { id: existing.id }, data })
    : prisma.channelMapping.create({
        data: { channelId: channel.id, externalRoomTypeId: input.externalRoomTypeId, externalUnitId: unitId, ...data },
      });
}

export async function deleteMapping(id: string) {
  const row = await prisma.channelMapping.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Bog'lanish");
  await prisma.channelMapping.delete({ where: { id } });
  return row;
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
  const rooms = await prisma.room.findMany({ select: { id: true, number: true } });
  const byNumber = new Map(rooms.map((r) => [r.number, r.id]));

  const mapped: Array<{ externalRoomTypeId: string; externalUnitId: string; roomId: string }> = [];
  const skipped: Array<{ externalRoomTypeId: string; externalUnitId: string; unitName: string }> = [];

  for (const rt of prop.roomTypes) {
    for (const u of rt.units) {
      const roomId = byNumber.get(u.name);
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
