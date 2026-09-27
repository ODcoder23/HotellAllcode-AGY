/**
 * Tozalash xabari — chiqish kuni va muddatidan oldin tugagan bron
 * (egasi talabi, 2026-09-26)
 *
 * "Mijoz bron kuni tugagach imroncleaning_bot guruhga tozalash kerakligi
 * xabarini jo'natadi; Shaxmatkadan muddatidan oldin bekor qilinsa ham
 * xabar borishi kerak."
 *
 * Shart: server + ALOHIDA test bazasi (vitest.setup.ts).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "./lib/prisma.js";
import { realRooms } from "./testUtils.js";
import { createDueCheckoutTasks } from "./services/cleaning.js";
import { hotelNow } from "./lib/hotelTime.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

const DAY = 86_400_000;
const key = (d: Date) => d.toISOString().slice(0, 10);

let rooms: Awaited<ReturnType<typeof realRooms>> = [];
const created: string[] = [];

describe("Tozalash xabari: chiqish kuni va muddatidan oldin tugagan bron", () => {
  beforeAll(async () => {
    rooms = await realRooms();
  });

  afterEach(async () => {
    const roomIds = rooms.slice(-3).map((r) => r.id);
    await prisma.cleaningTask.deleteMany({ where: { roomId: { in: roomIds } } });
    if (created.length > 0) {
      await prisma.payment.deleteMany({ where: { reservationId: { in: created } } });
      await prisma.reservation.deleteMany({ where: { id: { in: created } } });
      created.length = 0;
    }
  });

  it("mehmonxona vaqti — Toshkent (UTC+5): 20:30 UTC ertangi kunning 01:30 si", () => {
    const h = hotelNow(new Date("2026-09-26T20:30:00Z"));
    expect(key(h.today)).toBe("2026-09-27");
    expect(h.hour).toBe(1);
    expect(h.dayStartUtc.toISOString()).toBe("2026-09-26T19:00:00.000Z");
  });

  it("chiqish kuni soat 12:00 dan keyin — xabar; qayta chaqirilsa takrorlanmaydi; ertalab — hali yo'q", async () => {
    const room = rooms[rooms.length - 1];
    const { today, dayStartUtc } = hotelNow();
    const guest = await prisma.guest.create({ data: { fullName: "Chiqish Testi", phone: "+998900006666" } });
    const res = await prisma.reservation.create({
      data: {
        roomId: room.id, guestId: guest.id, checkIn: new Date(today.getTime() - 2 * DAY), checkOut: today,
        adults: 1, pricePerNight: 400000, source: "DIRECT", status: "CHECKED_IN",
      },
    });
    created.push(res.id);
    await prisma.cleaningTask.deleteMany({ where: { roomId: room.id } });

    // Toshkent 09:00 — chiqish soati hali kelmagan
    const morning = new Date(dayStartUtc.getTime() + 9 * 3_600_000);
    expect((await createDueCheckoutTasks(morning)).created).toBe(0);

    // Toshkent 13:00 — xabar
    // (serverning 10 daqiqalik tekshiruvi aynan shu payt ulgurgan bo'lishi
    // mumkin — muhimi, topshiriq bor va bitta)
    const noon = new Date(dayStartUtc.getTime() + 13 * 3_600_000);
    expect((await createDueCheckoutTasks(noon)).created).toBeLessThanOrEqual(1);
    expect(await prisma.cleaningTask.count({ where: { roomId: room.id } })).toBe(1);
    const task = await prisma.cleaningTask.findFirstOrThrow({ where: { roomId: room.id } });
    expect(task.isAuto).toBe(true);
    expect(task.reason).toContain("Chiqish kuni");

    // Bir kunda bir marta
    expect((await createDueCheckoutTasks(noon)).created).toBe(0);
  });

  it("Shaxmatkadan muddatidan oldin bekor qilinsa — xabar; kelajakdagi bron bekor qilinsa — yo'q", async () => {
    const [started, future] = rooms.slice(-3, -1);
    const { today } = hotelNow();
    await prisma.cleaningTask.deleteMany({ where: { roomId: { in: [started.id, future.id] } } });

    const book = async (roomId: string, from: number, to: number) => {
      const r = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId, guestName: "Bekor Testi", phone: "+998900006667", adults: 1,
          checkIn: key(new Date(today.getTime() + from * DAY)), checkOut: key(new Date(today.getTime() + to * DAY)),
          pricePerNight: 900000,
        }),
      });
      expect(r.status).toBe(201);
      created.push(r.body.id);
      return r.body.id as string;
    };

    // Yashash boshlangan (kecha keldi, ertaga ketadi)
    const a = await book(started.id, -1, 2);
    expect((await api(`/api/reservations/${a}/cancel`, { method: "POST", body: "{}" })).status).toBe(200);
    const t = await prisma.cleaningTask.findFirst({ where: { roomId: started.id } });
    expect(t?.reason).toContain("muddatidan oldin");

    // Kelajakdagi bron — xona ishlatilmagan
    const b = await book(future.id, 20, 22);
    expect((await api(`/api/reservations/${b}/cancel`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(await prisma.cleaningTask.count({ where: { roomId: future.id } })).toBe(0);
  });
});
