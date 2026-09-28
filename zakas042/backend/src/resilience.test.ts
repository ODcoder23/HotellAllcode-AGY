/**
 * Chidamlilik va yuklama
 *
 * Avvalgi reconciliation.test.ts dan PMS'ning o'ziga tegishli qismi
 * (Beds24 polling/drift testlari integratsiya bilan birga olib
 * tashlandi, 2026-09-26):
 *   - /health osilib qolmaydi, bron tez yaratiladi
 *   - buzilgan so'rovlar 400 (500 emas)
 *   - parallel yuklamada overbooking yo'q (TZ 3-band)
 *   - davriy vazifalar navbati ro'yxatdan o'tgan
 *
 * Shart: server + ALOHIDA test bazasi (vitest.setup.ts), Redis
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { TYPES, loadTypes, tariffFor } from "./testUtils.js";

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

const day = (offset: number): string => {
  const t = new Date(Date.now() + 5 * 3_600_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + offset)).toISOString().slice(0, 10);
};

const created: string[] = [];

describe("Chidamlilik va yuklama", () => {
  beforeAll(loadTypes);

  afterAll(async () => {
    if (created.length > 0) await prisma.reservation.deleteMany({ where: { id: { in: created } } });
  });

  describe("chidamlilik", () => {
    it("/health tez javob beradi — osilmaydi", async () => {
      // Redis ping timeout bilan o'ralgan (queues/index.ts): Redis o'chsa
      // ham /health javob beradi, "degraded" bilan
      const started = Date.now();
      const res = await api("/health");
      expect(res.status).toBe(200);
      expect(["ok", "degraded"]).toContain(res.body.status);
      expect(Date.now() - started, "/health juda sekin").toBeLessThan(3000);
    }, 15000);

    it("bron yaratish tez javob beradi", async () => {
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const started = Date.now();
      const res = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id, checkIn: day(300), checkOut: day(302),
          guestName: "Tezlik Testi", phone: "+99899200005", adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      expect(res.status).toBe(201);
      created.push(res.body.id);
      expect(Date.now() - started, "bron yaratish sekin").toBeLessThan(3000);
    }, 15000);

    it("buzilgan JSON 400 beradi, 500 emas", async () => {
      const res = await fetch(`${PMS}/api/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bu json emas",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("BAD_JSON");
    }, 15000);

    it("juda uzun matn rad etiladi", async () => {
      const room = await prisma.room.findFirstOrThrow({ where: { isActive: true } });
      const res = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id, checkIn: day(315), checkOut: day(316),
          guestName: "A".repeat(10_000), phone: "+99899200008", adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      expect(res.status).toBe(400);
    }, 15000);

    it("mavjud bo'lmagan ID — 404, noma'lum endpoint — 404 JSON", async () => {
      expect((await api("/api/reservations/yoq-id")).status).toBe(404);
      expect((await api("/api/reservations/yoq-id/check-in", { method: "POST" })).status).toBe(404);
      expect((await api("/api/rooms/999", { method: "PATCH", body: JSON.stringify({ status: "dirty" }) })).status).toBe(404);
      const unknown = await api("/api/yoq-endpoint");
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("NOT_FOUND");
    });
  });

  describe("yuklama", () => {
    it("50 parallel o'qish so'rovi xatosiz o'tadi", async () => {
      const results = await Promise.all(Array.from({ length: 50 }, () => api("/api/reservations")));
      expect(results.filter((r) => r.status === 200)).toHaveLength(50);
    }, 40000);

    it("20 parallel bron bitta xonaga — faqat bittasi o'tadi (TZ 3-band)", async () => {
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.b, isActive: true },
        select: { id: true },
      });
      const price = await tariffFor(room.id);

      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        api("/api/reservations", {
          method: "POST",
          body: JSON.stringify({
            roomId: room.id, checkIn: day(260), checkOut: day(262),
            guestName: `Yuklama ${i}`, phone: `+99890999${String(i).padStart(4, "0")}`,
            adults: 1, pricePerNight: price,
          }),
        })
      ));

      const ok = results.filter((r) => r.status === 201);
      expect(ok).toHaveLength(1);
      created.push(ok[0]!.body.id);
      // Qolganlari 409 (xona band yoki konflikt)
      expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    }, 60000);

    it("yuklamadan keyin DB'da kesishuvchi bron yo'q", async () => {
      const overlaps = await prisma.$queryRaw<Array<{ cnt: number }>>`
        SELECT COUNT(*)::int AS cnt
        FROM "Reservation" a
        JOIN "Reservation" b
          ON a."roomId" = b."roomId"
         AND a.id < b.id
         AND a."checkIn" < b."checkOut"
         AND b."checkIn" < a."checkOut"
        WHERE a.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND b.status NOT IN ('CANCELLED', 'NO_SHOW')
      `;
      expect(overlaps[0]?.cnt ?? 0).toBe(0);
    }, 30000);
  });

  describe("davriy vazifalar", () => {
    it("pms-maintenance va Beds24 navbatlari ro'yxatdan o'tgan (TZ 11-band)", async () => {
      const res = await api("/api/admin/queues");
      expect(res.status).toBe(200);
      const names = Object.keys(res.body.queues ?? {});
      for (const q of [
        "pms-maintenance", "beds24-reservation-sync", "beds24-availability-sync",
        "beds24-rate-sync", "beds24-webhook", "beds24-retry",
      ]) {
        expect(names, q).toContain(q);
      }
    });

    it("admin to'lanmagan bronlarni qo'lda tozalay oladi", async () => {
      const res = await api("/api/admin/maintenance/expire-unpaid", { method: "POST" });
      expect(res.status).toBe(200);
      expect(typeof res.body.checked).toBe("number");
    });
  });
});
