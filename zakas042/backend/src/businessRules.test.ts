/**
 * Biznes qoidalari — 2026-09-26 auditida topilib tuzatilgan xatolar
 *
 * Har test bitta xatoning regressiyasi: tuzatish qaytib buzilsa shu
 * yerda ko'rinadi. Ko'pchiligi real oqim — API orqali, qabulxona
 * qanday ishlasa shunday.
 *
 * Shart: server + ALOHIDA test bazasi (vitest.setup.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { realRooms, tariffFor } from "./testUtils.js";
import { hotelToday, addDays } from "./lib/hotelTime.js";
import { acceptTask, completeTask } from "./services/cleaning.js";
import { recalcCommissions } from "./services/expenses.js";
import { recalcAllRoomStatuses } from "./services/roomStatus.js";

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

const key = (d: Date) => d.toISOString().slice(0, 10);
const today = () => hotelToday();
const day = (n: number) => key(addDays(today(), n));

let rooms: Awaited<ReturnType<typeof realRooms>> = [];
const createdRes: string[] = [];

/** Seed bronlari yo'q, hozir bo'sh xona */
async function freeRoom(exclude: string[] = []): Promise<{ id: string; type: string }> {
  const busy = new Set(
    (await prisma.reservation.findMany({
      where: { status: { in: ["CHECKED_IN", "CONFIRMED", "PENDING_PAYMENT"] } },
      select: { roomId: true },
    })).map((r) => r.roomId)
  );
  const r = rooms.find((x) => !busy.has(x.id) && !exclude.includes(x.id) && x.status === "available");
  if (!r) throw new Error("bo'sh xona topilmadi");
  return r;
}

async function book(roomId: string, from: number, to: number, extra: Record<string, unknown> = {}) {
  const r = await api("/api/reservations", {
    method: "POST",
    body: JSON.stringify({
      roomId, guestName: "Qoida Testi", phone: "+998900005500", adults: 1,
      checkIn: day(from), checkOut: day(to), pricePerNight: await tariffFor(roomId) || 500_000,
      ...extra,
    }),
  });
  if (r.status === 201) createdRes.push(r.body.id);
  return r;
}

describe("Biznes qoidalari (2026-09-26 audit regressiyalari)", () => {
  beforeAll(async () => {
    rooms = await realRooms();
  });

  afterAll(async () => {
    if (createdRes.length > 0) {
      await prisma.reservation.deleteMany({ where: { id: { in: createdRes } } });
    }
  });

  describe("bron yaratish validatsiyasi", () => {
    it("bronni to'g'ridan-to'g'ri 'chiqib ketgan' / 'bekor' holatida yaratib bo'lmaydi", async () => {
      const room = await freeRoom();
      for (const status of ["checked_out", "checked_in", "cancelled", "no_show"]) {
        const r = await book(room.id, 200, 201, { status });
        expect(r.status, status).toBe(400);
      }
      const ok = await book(room.id, 200, 201, { status: "pending_payment" });
      expect(ok.status).toBe(201);
      expect(ok.body.status).toBe("pending_payment");
    });

    it("noma'lum manba 400 (ilgari 500 edi)", async () => {
      const room = await freeRoom();
      const r = await book(room.id, 202, 203, { source: "telegram_kanal" });
      expect(r.status).toBe(400);
      const ok = await book(room.id, 202, 203, { source: "BOOKING_COM" });
      expect(ok.status).toBe(201);
      expect(ok.body.source).toBe("booking_com");
    });

    it("mavjud bo'lmagan sana (30-fevral) rad etiladi — jimgina 2-martga aylanmaydi", async () => {
      const room = await freeRoom();
      const year = today().getUTCFullYear() + 1;
      const r = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id, guestName: "Sana", phone: "+998900005501", adults: 1,
          checkIn: `${year}-02-30`, checkOut: `${year}-03-02`, pricePerNight: 500_000,
        }),
      });
      expect(r.status).toBe(400);

      const pub = await api(`/api/public/availability?from=${year}-02-30&to=${year}-03-02`);
      expect(pub.status).toBe(400);
    });
  });

  describe("narx qoidasi (S4) — tahrirda ham", () => {
    it("tarifdan past narxga TAHRIR sababsiz rad etiladi, sabab bilan o'tadi va saqlanadi", async () => {
      const room = await freeRoom();
      const tariff = await tariffFor(room.id);
      expect(tariff).toBeGreaterThan(0);

      const created = await book(room.id, 20, 22);
      expect(created.status).toBe(201);

      const cheap = await api(`/api/reservations/${created.body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pricePerNight: 1 }),
      });
      expect(cheap.status, "tahrirda sababsiz chegirma o'tib ketdi").toBe(400);

      const withReason = await api(`/api/reservations/${created.body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pricePerNight: Math.round(tariff * 0.8), priceReason: "Doimiy mijoz" }),
      });
      expect(withReason.status).toBe(200);
      expect(withReason.body.pricePerNight).toBe(Math.round(tariff * 0.8));
      expect(withReason.body.priceReason).toBe("Doimiy mijoz");

      // Tarifdan yuqori narx — sababsiz erkin
      const higher = await api(`/api/reservations/${created.body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pricePerNight: tariff + 100_000 }),
      });
      expect(higher.status).toBe(200);
    });
  });

  describe("status va sana qoidalari", () => {
    it("kelajakdagi bronga check-in va 'kelmadi' qilib bo'lmaydi", async () => {
      const room = await freeRoom();
      const r = await book(room.id, 30, 32);
      expect(r.status).toBe(201);

      const ci = await api(`/api/reservations/${r.body.id}/check-in`, { method: "POST" });
      expect(ci.status).toBe(400);
      expect(String(ci.body.error)).toContain("boshlanadi");

      const ns = await api(`/api/reservations/${r.body.id}/no-show`, { method: "POST" });
      expect(ns.status).toBe(400);
    });

    it("bekor qilingan bronga xona/sana o'zgartirish va xizmat qo'shish rad etiladi", async () => {
      const room = await freeRoom();
      const other = await freeRoom([room.id]);
      const r = await book(room.id, 40, 42);
      await api(`/api/reservations/${r.body.id}/cancel`, { method: "POST" });

      const move = await api(`/api/reservations/${r.body.id}/change-room`, {
        method: "POST", body: JSON.stringify({ roomId: other.id }),
      });
      expect(move.status).toBe(400);

      const dates = await api(`/api/reservations/${r.body.id}/change-dates`, {
        method: "POST", body: JSON.stringify({ checkIn: day(41), checkOut: day(43) }),
      });
      expect(dates.status).toBe(400);

      const charge = await api(`/api/reservations/${r.body.id}/charges`, {
        method: "POST", body: JSON.stringify({ label: "Minibar", amount: 10_000 }),
      });
      expect(charge.status).toBe(400);
    });
  });

  describe("xona holati: chiqish, tozalash, yangi mehmon — real oqim", () => {
    it("oldingi mehmon chiqmaguncha yangisini kiritib bo'lmaydi; tozalashdan keyin xona qayta 'iflos' bo'lmaydi", async () => {
      const room = await freeRoom();

      // A: kecha kelgan, bugun ketadi — hali "Chiqish" bosilmagan
      const guestA = await prisma.guest.create({ data: { fullName: "Mehmon A", phone: "+998900005510" } });
      const a = await prisma.reservation.create({
        data: {
          roomId: room.id, guestId: guestA.id, checkIn: addDays(today(), -1), checkOut: today(),
          adults: 1, pricePerNight: 500_000, source: "DIRECT", status: "CHECKED_IN", checkedInAt: new Date(),
        },
      });
      createdRes.push(a.id);
      await prisma.room.update({ where: { id: room.id }, data: { status: "OCCUPIED" } });

      // B: bugun keladi
      const b = await book(room.id, 0, 1);
      expect(b.status).toBe(201);

      // Xona hali band (A chiqish qilmagan) — sana bo'yicha bo'sh ko'rinsa ham
      const state1 = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
      expect(state1.status).toBe("OCCUPIED");

      const early = await api(`/api/reservations/${b.body.id}/check-in`, { method: "POST" });
      expect(early.status, "bir xonaga ikki mehmon kiritildi").toBe(400);
      expect(String(early.body.error)).toContain("oldingi mehmon");

      // A chiqdi -> xona iflos, tozalash topshirig'i
      const out = await api(`/api/reservations/${a.id}/check-out`, { method: "POST" });
      expect(out.status).toBe(200);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("DIRTY");

      const dirtyIn = await api(`/api/reservations/${b.body.id}/check-in`, { method: "POST" });
      expect(dirtyIn.status).toBe(400);
      expect(String(dirtyIn.body.error)).toContain("tozalanmagan");

      // Farrosh tozaladi, admin tasdiqladi
      const task = await prisma.cleaningTask.findFirstOrThrow({
        where: { roomId: room.id, status: "NEW" }, orderBy: { createdAt: "desc" },
      });
      await acceptTask(task.id, "70000001", "Test Farrosh");
      await completeTask(task.id, "70000001");

      // Tasdiq kutilayotgan topshiriq "topshiriqsiz iflos xona" emas
      const panel = await api("/api/admin/cleaning");
      expect(panel.body.alerts.dirtyWithoutTask.map((r: any) => r.id)).not.toContain(room.id);

      const approve = await api(`/api/admin/cleaning/${task.id}/approve`, { method: "POST" });
      expect(approve.status).toBe(200);
      // Bugun mehmon keladi — bo'sh emas, "bron qilingan"
      expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("RESERVED");

      // 2026-09-26 gacha: shu xonaga yangi bron qilinsa qayta hisoblash
      // xonani yana DIRTY qilardi (bugun chiqib ketgan bron bor edi)
      const c = await book(room.id, 60, 61);
      expect(c.status).toBe(201);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("RESERVED");

      const ci = await api(`/api/reservations/${b.body.id}/check-in`, { method: "POST" });
      expect(ci.status).toBe(200);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("OCCUPIED");
    });

    it("tozalanmagan xona yangi bron tufayli 'bo'sh' bo'lib ketmaydi", async () => {
      const room = await freeRoom();
      await prisma.room.update({ where: { id: room.id }, data: { status: "DIRTY" } });

      const r = await book(room.id, 0, 2);
      expect(r.status).toBe(201);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("DIRTY");

      await prisma.room.update({ where: { id: room.id }, data: { status: "AVAILABLE" } });
    });

    it("mehmon boshqa xonaga ko'chirilsa eski xona tozalashga tushadi", async () => {
      const room = await freeRoom();
      const target = await freeRoom([room.id]);
      const r = await book(room.id, 0, 2);
      const ci = await api(`/api/reservations/${r.body.id}/check-in`, { method: "POST" });
      expect(ci.status).toBe(200);

      const moved = await api(`/api/reservations/${r.body.id}/change-room`, {
        method: "POST", body: JSON.stringify({ roomId: target.id }),
      });
      expect(moved.status).toBe(200);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("DIRTY");
      expect((await prisma.room.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("OCCUPIED");

      // Xonadagi mehmonning kirish sanasi o'zgarmaydi, chiqishi — mumkin
      const badDates = await api(`/api/reservations/${r.body.id}/change-dates`, {
        method: "POST", body: JSON.stringify({ checkIn: day(1), checkOut: day(3) }),
      });
      expect(badDates.status).toBe(400);
      const extend = await api(`/api/reservations/${r.body.id}/change-dates`, {
        method: "POST", body: JSON.stringify({ checkIn: r.body.checkIn, checkOut: day(3) }),
      });
      expect(extend.status).toBe(200);

      await api(`/api/reservations/${r.body.id}/check-out`, { method: "POST" });
      for (const id of [room.id, target.id]) {
        await prisma.room.update({ where: { id }, data: { status: "AVAILABLE" } });
      }
      await prisma.cleaningTask.deleteMany({ where: { roomId: { in: [room.id, target.id] } } });
    });
  });

  describe("xona holati kun almashganda (soatlik room_status vazifasi)", () => {
    it("kelish kuni kelgan bron xonasi RESERVED, eskirgan RESERVED esa AVAILABLE bo'ladi", async () => {
      const r1 = await freeRoom();
      const r2 = await freeRoom([r1.id]);

      // r1: bugun keladigan bron, lekin holat kechagi kun bo'yicha (AVAILABLE)
      // qolgan — kecha "ertaga keladi" deb yaratilgan bronning o'zi shu
      const guest = await prisma.guest.create({ data: { fullName: "Kun Almashdi", phone: "+998900005590" } });
      const a = await prisma.reservation.create({
        data: {
          roomId: r1.id, guestId: guest.id, checkIn: today(), checkOut: addDays(today(), 2),
          adults: 1, pricePerNight: 500_000, source: "DIRECT", status: "CONFIRMED",
        },
      });
      createdRes.push(a.id);
      await prisma.room.update({ where: { id: r1.id }, data: { status: "AVAILABLE" } });
      // r2: bugun hech kim kelmaydi, lekin RESERVED bo'lib qolib ketgan
      await prisma.room.update({ where: { id: r2.id }, data: { status: "RESERVED" } });

      const { changed } = await recalcAllRoomStatuses();
      expect(changed).toEqual(expect.arrayContaining([r1.id, r2.id]));
      expect((await prisma.room.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("RESERVED");
      expect((await prisma.room.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("AVAILABLE");

      // Qayta chaqirish hech narsani o'zgartirmaydi
      const again = await recalcAllRoomStatuses();
      expect(again.changed).not.toContain(r1.id);
      expect(again.changed).not.toContain(r2.id);

      // Ta'mirdagi xonaga tegilmaydi
      await prisma.room.update({ where: { id: r2.id }, data: { status: "OUT_OF_ORDER" } });
      await recalcAllRoomStatuses();
      expect((await prisma.room.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("OUT_OF_ORDER");

      await prisma.reservation.delete({ where: { id: a.id } });
      await prisma.room.updateMany({ where: { id: { in: [r1.id, r2.id] } }, data: { status: "AVAILABLE" } });
    });
  });

  describe("hisobot va xarajatlar", () => {
    it("OTA komissiyasi parallel qayta hisoblashda ikki marta yozilmaydi", async () => {
      const room = await freeRoom();
      const r = await book(room.id, 70, 72, { source: "booking_com" });
      expect(r.status).toBe(201);

      const from = addDays(today(), 70);
      const toEx = addDays(today(), 71);
      await Promise.all(Array.from({ length: 6 }, () => recalcCommissions(from, toEx)));

      const rows = await prisma.expense.count({ where: { reservationId: r.body.id, isAuto: true } });
      expect(rows, "komissiya dublikati").toBe(1);
    });

    it("o'rtacha kecha kelmagan bronlarni maxrajga qo'shmaydi", async () => {
      const room = await freeRoom();
      // O'tmishdagi (30 kun ichida) sana — "kelmadi" faqat kirish kuni kelgach
      const a = await book(room.id, -20, -17);        // 3 kecha
      const b = await book(room.id, -15, -14);        // 1 kecha -> kelmadi
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((await api(`/api/reservations/${b.body.id}/no-show`, { method: "POST" })).status).toBe(200);

      // Faqat shu ikki bron tushadigan davr — boshqa bronlar chalkashtirmasin
      await prisma.reservation.updateMany({
        where: { id: { notIn: [a.body.id, b.body.id] }, checkIn: { gte: addDays(today(), -20), lt: addDays(today(), -13) } },
        data: { checkIn: addDays(today(), 300), checkOut: addDays(today(), 301) },
      });

      const auth = await founderToken();
      const report = await api(`/api/admin/report?from=${day(-20)}&to=${day(-14)}`, auth);
      expect(report.status).toBe(200);
      // Faol bron bitta (3 kecha) — o'rtacha 3, 2 emas (ilgari 4/2 = 2 edi)
      expect(report.body.bookings.avgNights).toBe(3);
      expect(report.body.channel).toBeUndefined();
    });
  });
});

/** Hisobot FOUNDER huquqi — auth yoqilgan bo'lsa token kerak */
async function founderToken(): Promise<RequestInit> {
  const health = await api("/health");
  if (health.body?.security?.auth !== true) return {};
  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "founder@imron.local", password: "admin12345" }),
  });
  return { headers: { Authorization: `Bearer ${login.body.token}` } };
}
