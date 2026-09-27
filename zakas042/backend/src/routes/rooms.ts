/**
 * Xona endpoint'lari — Shaxmatka uchun
 * Frontend `rooms` massivi shakliga mos (02-fayl §3).
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { asyncHandler, AppError, NotFoundError, ValidationError } from "../lib/errors.js";
import { serializeRoom, serializeRoomType, serializeFloor, fromDateKey, isValidDateKey } from "../lib/serialize.js";
import { can } from "../services/auth.js";
import { audit } from "../services/auditLog.js";
import { recalcRoomStatus } from "../services/roomStatus.js";
import { recalcTypeHorizon, availabilityGrid } from "../services/availability.js";
import { notifyRoomStatus } from "../realtime/notify.js";
import {
  blockRooms,
  unblockRooms,
  blockFloor,
  unblockFloor,
  listBlocked,
} from "../services/roomBlocking.js";

export const roomsRouter = Router();

// --- GET /api/rooms -----------------------------------------
roomsRouter.get("/", requireAuth, requirePermission("reservation.read"), asyncHandler(async (_req, res) => {
  const rooms = await prisma.room.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(rooms.map(serializeRoom));
}));

// --- GET /api/rooms/types -----------------------------------
roomsRouter.get("/types", requireAuth, requirePermission("reservation.read"), asyncHandler(async (_req, res) => {
  const types = await prisma.roomType.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(types.map(serializeRoomType));
}));

// --- GET /api/rooms/availability?from=&to= ------------------
// Tur x kun bo'yicha bo'sh xonalar soni (admin "Mavjudlik" jadvali).
// `to` kirmaydi ('[)'). Oraliq 62 kundan oshmaydi — so'rov og'irlashmasin.
roomsRouter.get("/availability", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!isValidDateKey(from) || !isValidDateKey(to)) throw new ValidationError("from/to: YYYY-MM-DD shaklida bo'lishi kerak");
  const fromDate = fromDateKey(from);
  const toDate = fromDateKey(to);
  if (toDate <= fromDate) throw new ValidationError("'to' sanasi 'from' dan keyin bo'lishi kerak");
  if (toDate.getTime() - fromDate.getTime() > 62 * 86_400_000) throw new ValidationError("Oraliq 62 kundan oshmasin");

  res.json(await availabilityGrid(fromDate, toDate));
}));

// --- GET /api/rooms/available?from=&to= ---------------------
// Shaxmatkadagi availableRoomsFor() ga mos
roomsRouter.get("/available", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const { from, to, exclude } = req.query;
  if (!from || !to) throw new ValidationError("from va to parametrlari kerak");
  if (!isValidDateKey(from) || !isValidDateKey(to)) throw new ValidationError("from/to: YYYY-MM-DD shaklida bo'lishi kerak");
  if (fromDateKey(to) <= fromDateKey(from)) throw new ValidationError("'to' sanasi 'from' dan keyin bo'lishi kerak");

  const checkIn = fromDateKey(from);
  const checkOut = fromDateKey(to);

  /**
   * UCH SO'ROV, xona soniga bog'liq emas.
   *
   * Ilgari har xona uchun `isRoomFree()` chaqirilardi: 18 xona x
   * 2 so'rov = 36 ketma-ket so'rov. Prisma ulanish hovuzi (9 ta)
   * tugab, endpoint 10 soniyadan keyin 500 qaytarardi (P2024).
   * Xona soni ortgani sari holat yomonlashardi.
   *
   * Mantiq `isRoomFree()` bilan AYNAN bir xil bo'lishi shart:
   * band bron + yopilgan kun. Ikkalasi ham shu yerda takrorlangan,
   * chunki bittalab tekshiruv o'rniga to'plam olinmoqda.
   */
  const [rooms, busy, blocked] = await Promise.all([
    prisma.room.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),

    // Oraliqqa tushadigan bronlar — `[checkIn, checkOut)` qoidasi
    prisma.reservation.findMany({
      where: {
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
        ...(exclude ? { id: { not: exclude } } : {}),
      },
      select: { roomId: true },
    }),

    // Ta'mir/xizmatdan chiqarilgan kunlar
    prisma.roomDayStatus.findMany({
      where: { isBlocked: true, date: { gte: checkIn, lt: checkOut } },
      select: { roomId: true },
    }),
  ]);

  const taken = new Set([
    ...busy.map((b) => b.roomId),
    ...blocked.map((b) => b.roomId),
  ]);

  res.json(rooms.filter((r) => !taken.has(r.id)).map(serializeRoom));
}));

// --- PATCH /api/rooms/:id — holat o'zgartirish --------------
//
// Katta harf ham qabul qilinadi: Shaxmatka kichik harf yuboradi
// ("dirty"), admin panel esa Prisma enum shaklida ("DIRTY").
//
// "reserved" va "occupied" qo'lda qo'yilmaydi — ular bronlardan
// hisoblanadi (services/roomStatus.ts). Qo'lda qo'yilsa keyingi bron
// amali ularni jimgina qaytarib yozardi.
const statusSchema = z.object({
  status: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(
      z.enum(["available", "dirty", "out_of_order", "out_of_service"], {
        errorMap: () => ({ message: "Holat: available, dirty, out_of_order yoki out_of_service" }),
      })
    ),
});

const UNSELLABLE = new Set(["OUT_OF_ORDER", "OUT_OF_SERVICE"]);

// ============================================================
//  QAVATLAR
//  DIQQAT: bu yo'llar "/:id" dan OLDIN turishi shart, aks holda
//  Express "floors" ni xona ID'si deb qabul qiladi.
// ============================================================

// --- GET /api/rooms/floors ----------------------------------
roomsRouter.get("/floors", requireAuth, requirePermission("reservation.read"), asyncHandler(async (_req, res) => {
  const floors = await prisma.floor.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(floors.map(serializeFloor));
}));

// ============================================================
//  XONA YOPISH (ta'mir, xizmatdan chiqarish)
//
//  Yopilgan xona butun zanjir bo'ylab tarqaladi:
//    RoomDayStatus -> Availability (sayt) -> WebSocket (Shaxmatka)
//  Tafsilot: services/roomBlocking.ts
// ============================================================

const blockRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from: YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to: YYYY-MM-DD"),
  reason: z.string().max(200).optional(),
});

const blockRoomsSchema = blockRangeSchema.extend({
  roomIds: z.array(z.string().min(1)).min(1, "Kamida bitta xona"),
  /** Bron bo'lsa ham yopish. Faqat ataylab ishlatiladi. */
  force: z.boolean().optional(),
});

const blockFloorSchema = blockRangeSchema.extend({
  floorId: z.string().min(1),
  force: z.boolean().optional(),
});

// --- GET /api/rooms/blocks?from=&to=&roomIds= ---------------
// Shaxmatka yopiq kunlarni kulrang ko'rsatishi uchun
roomsRouter.get("/blocks", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!from || !to) throw new ValidationError("from va to talab qilinadi");

  const raw = req.query.roomIds;
  const roomIds = typeof raw === "string" && raw.length > 0 ? raw.split(",") : undefined;

  res.json(await listBlocked(from, to, roomIds));
}));

/**
 * `force` — bron bor xonani ham yopish (suv toshqini, avariya). Mehmonlar
 * keyin boshqa xonaga ko'chiriladi. Hujjatda "faqat ADMIN" deyilgan edi,
 * lekin tekshiruv yo'q edi — menejer ham ishlata olardi.
 */
function assertForceAllowed(req: AuthedRequest, force: boolean | undefined): void {
  if (force && req.user && !can(req.user.role, "settings.write")) {
    throw new AppError(403, "Bron bor xonani majburan yopish — faqat administrator", "FORBIDDEN");
  }
}

// --- POST /api/rooms/blocks ---------------------------------
roomsRouter.post("/blocks", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { roomIds, force, ...range } = blockRoomsSchema.parse(req.body);
  assertForceAllowed(req, force);
  const result = await blockRooms(roomIds, range, {
    userId: req.user?.id,
    force,
    ipAddress: req.ip,
  });
  res.status(201).json(result);
}));

// --- DELETE /api/rooms/blocks -------------------------------
// Yopiqni bekor qiladi. DELETE + body: o'chirilayotgan narsa
// bitta resurs emas, oraliq — URL'ga sig'maydi.
roomsRouter.delete("/blocks", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { roomIds, ...range } = blockRoomsSchema.omit({ force: true }).parse(req.body);
  const result = await unblockRooms(roomIds, range, {
    userId: req.user?.id,
    ipAddress: req.ip,
  });
  res.json(result);
}));

// --- POST /api/rooms/blocks/floor ---------------------------
roomsRouter.post("/blocks/floor", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { floorId, force, ...range } = blockFloorSchema.parse(req.body);
  assertForceAllowed(req, force);
  const result = await blockFloor(floorId, range, {
    userId: req.user?.id,
    force,
    ipAddress: req.ip,
  });
  res.status(201).json(result);
}));

// --- DELETE /api/rooms/blocks/floor -------------------------
roomsRouter.delete("/blocks/floor", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { floorId, ...range } = blockFloorSchema.omit({ force: true }).parse(req.body);
  const result = await unblockFloor(floorId, range, {
    userId: req.user?.id,
    ipAddress: req.ip,
  });
  res.json(result);
}));

// ============================================================
//  XONA HOLATI
// ============================================================

/**
 * Xona holatini qo'lda o'zgartirish.
 *
 * HUQUQ (2026-09-26): qabulxona (`checkin.write`) faqat "iflos" deb
 * belgilay oladi. Iflos xonani ochish (tozalash tasdig'isiz) va
 * ta'mirga qo'yish/chiqarish — sotuvdagi inventarni o'zgartiradi,
 * shuning uchun `room.block` (menejer va yuqori). Ilgari qabulxona
 * iflos xonani "bo'sh" qilib, egasi talab qilgan tozalash tasdig'ini
 * chetlab o'ta olardi.
 *
 * Xonada mehmon bo'lsa ta'mirga qo'yib bo'lmaydi — avval ko'chiring.
 * Natijaviy holat bronlardan qayta hisoblanadi (bo'sh -> band bo'lishi
 * mumkin), Shaxmatka WebSocket orqali ko'radi, sayt keshi yangilanadi.
 */
roomsRouter.patch("/:id", requireAuth, requirePermission("checkin.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { status } = statusSchema.parse(req.body);
  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room) throw new NotFoundError(`Xona ${req.params.id}`);

  const next = status.toUpperCase() as "AVAILABLE" | "DIRTY" | "OUT_OF_ORDER" | "OUT_OF_SERVICE";
  const sellabilityChanges = UNSELLABLE.has(next) !== UNSELLABLE.has(room.status);
  const opensDirty = room.status === "DIRTY" && next === "AVAILABLE";

  if ((sellabilityChanges || opensDirty) && req.user && !can(req.user.role, "room.block")) {
    throw new AppError(
      403,
      opensDirty
        ? "Iflos xona tozalash tasdig'i bilan ochiladi (admin panel -> Tozalik)"
        : "Xonani ta'mirga qo'yish yoki chiqarish — menejer huquqi",
      "FORBIDDEN"
    );
  }

  if (UNSELLABLE.has(next)) {
    const guest = await prisma.reservation.findFirst({
      where: { roomId: room.id, status: "CHECKED_IN" },
      select: { guest: { select: { fullName: true } } },
    });
    if (guest) {
      throw new ValidationError(`Xonada mehmon bor (${guest.guest.fullName}) — avval boshqa xonaga ko'chiring`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.room.update({ where: { id: room.id }, data: { status: next } });
    // "Bo'sh" deyilgan xona bugun mehmon kutayotgan bo'lsa — RESERVED
    await recalcRoomStatus(room.id, tx);
  });
  const updated = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });

  if (sellabilityChanges) await recalcTypeHorizon([room.roomTypeId]);
  await notifyRoomStatus(room.id);

  if (updated.status !== room.status) {
    await audit({
      userId: req.user?.id,
      action: "room.status_changed",
      entityType: "Room",
      entityId: room.id,
      before: { status: room.status },
      after: { status: updated.status },
      ipAddress: req.ip,
    });
  }

  res.json(serializeRoom(updated));
}));
