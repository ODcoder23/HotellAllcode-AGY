/**
 * Xona endpoint'lari — Shaxmatka uchun
 * Frontend `rooms` massivi shakliga mos (02-fayl §3).
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, NotFoundError, ValidationError } from "../lib/errors.js";
import { serializeRoom, serializeRoomType, fromDateKey } from "../lib/serialize.js";
import { isRoomFree } from "../services/reservations.js";

export const roomsRouter = Router();

// --- GET /api/rooms -----------------------------------------
roomsRouter.get("/", asyncHandler(async (_req, res) => {
  const rooms = await prisma.room.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(rooms.map(serializeRoom));
}));

// --- GET /api/rooms/types -----------------------------------
roomsRouter.get("/types", asyncHandler(async (_req, res) => {
  const types = await prisma.roomType.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(types.map(serializeRoomType));
}));

// --- GET /api/rooms/available?from=&to= ---------------------
// Shaxmatkadagi availableRoomsFor() ga mos
roomsRouter.get("/available", asyncHandler(async (req, res) => {
  const { from, to, exclude } = req.query;
  if (!from || !to) throw new ValidationError("from va to parametrlari kerak");

  const checkIn = fromDateKey(from);
  const checkOut = fromDateKey(to);
  const rooms = await prisma.room.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  const free = [];
  for (const r of rooms) {
    if (await isRoomFree(r.id, checkIn, checkOut, exclude)) free.push(r);
  }
  res.json(free.map(serializeRoom));
}));

// --- PATCH /api/rooms/:id — holat o'zgartirish --------------
const statusSchema = z.object({
  status: z.enum(["available", "reserved", "occupied", "dirty", "out_of_order", "out_of_service"]),
});

roomsRouter.patch("/:id", asyncHandler(async (req, res) => {
  const { status } = statusSchema.parse(req.body);
  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room) throw new NotFoundError(`Xona ${req.params.id}`);

  const updated = await prisma.room.update({
    where: { id: req.params.id },
    data: { status: status.toUpperCase() as never },
  });
  res.json(serializeRoom(updated));
}));
