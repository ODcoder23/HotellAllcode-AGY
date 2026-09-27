/**
 * Availability keshi — tur x kun bo'yicha bo'sh xonalar
 *
 * TZ 6-band: "Xona band qilinsa availability kamayadi, bekor qilinsa
 *             qayta oshadi."
 *
 * Kesh sayt qidiruvi uchun (publicBooking.ts). Qoida sayt xona
 * tanlashi (`pickRoom`) bilan BIR XIL bo'lishi shart: aks holda sayt
 * "1 xona bor" deydi, bron esa "bo'sh xona qolmadi" bilan rad etiladi.
 *
 * Ishga tushirish:  npx vitest run src/availability.test.ts
 * Shart: server, PostgreSQL (test bazasi), Redis
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { recalcAvailability, readRange } from "./services/availability.js";
import { fromDateKey } from "./lib/serialize.js";
import { TYPES, loadTypes } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";

/** Tur bo'yicha sotuvdagi xona soni — BAZADAN */
const TOTAL: Record<string, number> = {};

async function loadTotals() {
  for (const typeId of [TYPES.a, TYPES.b, TYPES.c]) {
    TOTAL[typeId] = await prisma.room.count({
      where: { roomTypeId: typeId, isActive: true, status: { notIn: ["OUT_OF_ORDER", "OUT_OF_SERVICE"] } },
    });
  }
}

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

/** Bir xona turidagi xonalar (tartib bilan) */
async function roomsOf(roomTypeId: string) {
  return prisma.room.findMany({
    where: { roomTypeId, isActive: true },
    orderBy: { number: "asc" },
  });
}

const D = (key: string) => fromDateKey(key);

/** Test oraliqlari 2028 yilda — seed bronlariga tegmaydi */
const FAR = D("2028-01-01");

async function cleanFar() {
  await prisma.reservation.deleteMany({ where: { checkIn: { gte: FAR } } });
  await prisma.availability.deleteMany({ where: { date: { gte: FAR } } });
  await prisma.roomDayStatus.deleteMany({ where: { date: { gte: FAR } } });
}

describe("Availability keshi (TZ 6-band)", () => {
  beforeAll(async () => {
    await loadTypes();
    await loadTotals();
  });

  beforeEach(cleanFar);

  afterAll(async () => {
    await cleanFar();
    // Ta'mirga qo'yilgan xonalar qaytariladi — keyingi testlarga oqmasin
    await prisma.room.updateMany({
      where: { status: { in: ["OUT_OF_ORDER", "OUT_OF_SERVICE"] } },
      data: { status: "AVAILABLE" },
    });
  });

  describe("agregatsiya — aniq xona -> tur bo'yicha son", () => {
    it("bron yo'q oraliqda availableCount = sotuvdagi xonalar soni", async () => {
      await recalcAvailability([TYPES.a], D("2028-03-01"), D("2028-03-05"));
      const days = await readRange(TYPES.a, D("2028-03-01"), D("2028-03-05"));

      expect(days).toHaveLength(4);          // 01,02,03,04 — 05 kirmaydi
      for (const d of days) {
        expect(d.totalRooms).toBe(TOTAL[TYPES.a]);
        expect(d.availableCount).toBe(TOTAL[TYPES.a]);
      }
    });

    it("bitta bron -> faqat o'sha kunlar bittaga kamayadi (`[)` qoidasi)", async () => {
      const [room] = await roomsOf(TYPES.a);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room!.id,
          checkIn: "2028-03-10",
          checkOut: "2028-03-12",
          guestName: "Agregatsiya Testi",
          phone: "+99894400001",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      await recalcAvailability([TYPES.a], D("2028-03-09"), D("2028-03-14"));
      const days = await readRange(TYPES.a, D("2028-03-09"), D("2028-03-14"));
      const byDate = new Map(days.map((d) => [d.date, d.availableCount]));
      const total = TOTAL[TYPES.a];

      expect(byDate.get("2028-03-09")).toBe(total);      // bron oldin
      expect(byDate.get("2028-03-10")).toBe(total - 1);  // checkIn KIRADI
      expect(byDate.get("2028-03-11")).toBe(total - 1);
      expect(byDate.get("2028-03-12")).toBe(total);      // checkOut KIRMAYDI
      expect(byDate.get("2028-03-13")).toBe(total);
    });

    it("bron yaratilganda kesh O'ZI yangilanadi (qo'lda qayta hisoblashsiz)", async () => {
      const [room] = await roomsOf(TYPES.b);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room!.id, checkIn: "2028-03-20", checkOut: "2028-03-21",
          guestName: "Avto Kesh", phone: "+99894400009", adults: 1, pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      const days = await readRange(TYPES.b, D("2028-03-20"), D("2028-03-21"));
      expect(days).toHaveLength(1);
      expect(days[0]!.availableCount).toBe(TOTAL[TYPES.b] - 1);
    });

    it("bekor qilingan bron bandlikka kirmaydi — son qayta oshadi", async () => {
      const [room] = await roomsOf(TYPES.b);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room!.id,
          checkIn: "2028-04-01",
          checkOut: "2028-04-03",
          guestName: "Bekor Testi",
          phone: "+99894400002",
          adults: 1,
          pricePerNight: 90,
        }),
      });
      expect(created.status).toBe(201);

      let days = await readRange(TYPES.b, D("2028-04-01"), D("2028-04-03"));
      expect(days[0]!.availableCount).toBe(TOTAL[TYPES.b] - 1);

      const cancelled = await api(`/api/reservations/${created.body.id}/cancel`, { method: "POST" });
      expect(cancelled.status).toBe(200);

      days = await readRange(TYPES.b, D("2028-04-01"), D("2028-04-03"));
      expect(days[0]!.availableCount).toBe(TOTAL[TYPES.b]);
    });

    it("availableCount hech qachon manfiy yoki jami sondan katta emas", async () => {
      const types = [TYPES.a, TYPES.b, TYPES.c];
      await recalcAvailability(types, D("2028-05-01"), D("2028-05-10"));

      for (const type of types) {
        const days = await readRange(type, D("2028-05-01"), D("2028-05-10"));
        expect(days, `${type} uchun kesh yo'q`).toHaveLength(9);
        for (const d of days) {
          expect(d.availableCount).toBeLessThanOrEqual(TOTAL[type]!);
          expect(d.availableCount).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe("GET /api/rooms/availability — admin 'Mavjudlik' jadvali", () => {
    it("hamma tur qaytadi, son bron bilan kamayadi ('[)' qoidasi)", async () => {
      const [room] = await roomsOf(TYPES.a);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room!.id, checkIn: "2028-08-10", checkOut: "2028-08-12",
          guestName: "Mavjudlik Jadvali", phone: "+99894400011", adults: 1, pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      const grid = await api("/api/rooms/availability?from=2028-08-09&to=2028-08-13");
      expect(grid.status).toBe(200);
      const typeCount = await prisma.roomType.count();
      expect(grid.body).toHaveLength(typeCount);

      const row = grid.body.find((r: any) => r.roomTypeId === TYPES.a);
      expect(row.days.map((d: any) => d.date)).toEqual(["2028-08-09", "2028-08-10", "2028-08-11", "2028-08-12"]);
      const total = TOTAL[TYPES.a]!;
      expect(row.days.map((d: any) => d.availableCount)).toEqual([total, total - 1, total - 1, total]);
      for (const d of row.days) expect(d.totalRooms).toBe(total);

      // Kesh bilan bir xil manba — sayt qidiruvi shu sonni ko'radi
      const cached = await readRange(TYPES.a, D("2028-08-09"), D("2028-08-13"));
      expect(cached.map((d) => d.availableCount)).toEqual(row.days.map((d: any) => d.availableCount));
    });

    it("noto'g'ri sana va juda uzun oraliq rad etiladi", async () => {
      expect((await api("/api/rooms/availability?from=2028-02-30&to=2028-03-02")).status).toBe(400);
      expect((await api("/api/rooms/availability?from=2028-03-05&to=2028-03-01")).status).toBe(400);
      expect((await api("/api/rooms/availability?from=2028-01-01&to=2028-06-01")).status).toBe(400);
      expect((await api("/api/rooms/availability")).status).toBe(400);
    });
  });

  describe("yopiq kunlar va ta'mirdagi xonalar", () => {
    it("xona yopilsa kun bittaga kamayadi, ochilsa qaytadi", async () => {
      const [room] = await roomsOf(TYPES.c);
      const blocked = await api("/api/rooms/blocks", {
        method: "POST",
        body: JSON.stringify({ roomIds: [room!.id], from: "2028-06-01", to: "2028-06-02", reason: "Ta'mir" }),
      });
      expect(blocked.status).toBe(201);
      expect(blocked.body.daysAffected).toBe(2);

      // Kesh faqat o'zgargan kunlar uchun yangilanadi — qo'shni kunni
      // solishtirish uchun oraliq to'liq hisoblanadi
      await recalcAvailability([TYPES.c], D("2028-06-01"), D("2028-06-04"));
      let days = await readRange(TYPES.c, D("2028-06-01"), D("2028-06-04"));
      const byDate = new Map(days.map((d) => [d.date, d.availableCount]));
      expect(byDate.get("2028-06-01")).toBe(TOTAL[TYPES.c]! - 1);
      expect(byDate.get("2028-06-02")).toBe(TOTAL[TYPES.c]! - 1);   // `to` ham yopiq (inclusive)
      expect(byDate.get("2028-06-03")).toBe(TOTAL[TYPES.c]);

      const opened = await api("/api/rooms/blocks", {
        method: "DELETE",
        body: JSON.stringify({ roomIds: [room!.id], from: "2028-06-01", to: "2028-06-02" }),
      });
      expect(opened.status).toBe(200);
      days = await readRange(TYPES.c, D("2028-06-01"), D("2028-06-03"));
      for (const d of days) expect(d.availableCount).toBe(TOTAL[TYPES.c]);
    });

    it("bron bor xonani majburan yopish — band kun ikki marta ayirilmaydi", async () => {
      const [room] = await roomsOf(TYPES.a);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room!.id, checkIn: "2028-07-01", checkOut: "2028-07-03",
          guestName: "Majburiy Yopish", phone: "+99894400003", adults: 1, pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      // force'siz — rad etiladi (bron bor)
      const refused = await api("/api/rooms/blocks", {
        method: "POST",
        body: JSON.stringify({ roomIds: [room!.id], from: "2028-07-01", to: "2028-07-01" }),
      });
      expect(refused.status).toBe(400);

      const forced = await api("/api/rooms/blocks", {
        method: "POST",
        body: JSON.stringify({ roomIds: [room!.id], from: "2028-07-01", to: "2028-07-01", force: true }),
      });
      expect(forced.status).toBe(201);

      const days = await readRange(TYPES.a, D("2028-07-01"), D("2028-07-02"));
      // Xona band VA yopiq — sotuvdan bir marta chiqadi
      expect(days[0]!.availableCount).toBe(TOTAL[TYPES.a]! - 1);
    });

    it("ta'mirga qo'yilgan xona sotuvdan chiqadi — sayt qidiruvi bron bilan mos", async () => {
      const rooms = await roomsOf(TYPES.c);
      const target = rooms[rooms.length - 1]!;

      // Kelajakdagi sana: bugungi bronlar ta'sir qilmasin
      const from = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.now() + 201 * 86_400_000).toISOString().slice(0, 10);

      const before = await api(`/api/public/availability?from=${from}&to=${to}&adults=1`);
      const countBefore = before.body.roomTypes.find((t: any) => t.id === TYPES.c)?.availableCount;
      expect(countBefore).toBe(TOTAL[TYPES.c]);

      const ooo = await api(`/api/rooms/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "out_of_order" }),
      });
      expect(ooo.status).toBe(200);
      expect(ooo.body.status).toBe("out_of_order");

      const after = await api(`/api/public/availability?from=${from}&to=${to}&adults=1`);
      const countAfter = after.body.roomTypes.find((t: any) => t.id === TYPES.c)?.availableCount ?? 0;
      expect(countAfter).toBe(TOTAL[TYPES.c]! - 1);

      // Qaytarish — son tiklanadi
      const back = await api(`/api/rooms/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "available" }),
      });
      expect(back.status).toBe(200);
      const restored = await api(`/api/public/availability?from=${from}&to=${to}&adults=1`);
      expect(restored.body.roomTypes.find((t: any) => t.id === TYPES.c)?.availableCount).toBe(TOTAL[TYPES.c]);
    });
  });
});
