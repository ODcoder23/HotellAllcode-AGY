/**
 * FAZA 2A — API integratsiya testlari
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "barcha amallar API orqali ishlaydi, javob formati frontend
 *    kutgan shaklda"
 *
 * Ishga tushirish:  npm test
 * Shart: server ishlab turishi kerak (npm run dev)
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

const day = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
};

describe("FAZA 2A — ichki REST API", () => {
  beforeAll(async () => {
    const { status } = await api("/health");
    if (status !== 200) throw new Error("Server ishlamayapti — `npm run dev` ishga tushiring");
  });

  // --- Format (02-fayl §3) ----------------------------------
  describe("javob formati — Shaxmatka moslik jadvali", () => {
    it("rooms: id = xona raqami, type kichik harf", async () => {
      const { body } = await api("/api/rooms");
      expect(body).toHaveLength(12);

      const r101 = body.find((r: any) => r.id === "101");
      expect(r101).toBeDefined();
      expect(r101.number).toBe("101");          // Q2
      expect(r101.type).toBe("standard");        // kichik harf
      expect(typeof r101.floor).toBe("number");
      expect(r101.status).toMatch(/^[a-z_]+$/);  // "occupied", "available"
    });

    it("rooms: turlar bo'yicha 6/4/2 (02-fayl §4)", async () => {
      const { body } = await api("/api/rooms");
      const count = (t: string) => body.filter((r: any) => r.type === t).length;
      expect(count("standard")).toBe(6);
      expect(count("double")).toBe(4);
      expect(count("deluxe")).toBe(2);
    });

    it("reservations: guest flatten, Decimal → number, sana string", async () => {
      const { body } = await api("/api/reservations");
      expect(body.length).toBeGreaterThan(0);

      const r = body[0];
      expect(typeof r.guestName).toBe("string");       // flatten
      expect(typeof r.phone).toBe("string");           // flatten
      expect(r.guest).toBeUndefined();                 // ichma-ich obyekt YO'Q
      expect(typeof r.pricePerNight).toBe("number");   // Decimal emas
      expect(r.checkIn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.checkOut).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof r.createdAt).toBe("number");       // epoch ms
      expect(Array.isArray(r.charges)).toBe(true);
      expect(Array.isArray(r.payments)).toBe(true);
    });

    it("reservations: source va status kichik harfda", async () => {
      const { body } = await api("/api/reservations");
      for (const r of body) {
        expect(r.source).toMatch(/^[a-z_]+$/);
        expect(r.status).toMatch(/^[a-z_]+$/);
      }
    });

    it("payments: amount number, date 'YYYY-MM-DD'", async () => {
      const { body } = await api("/api/reservations");
      const withPayment = body.find((r: any) => r.payments.length > 0);
      expect(withPayment).toBeDefined();

      const p = withPayment.payments[0];
      expect(typeof p.amount).toBe("number");
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof p.method).toBe("string");
    });
  });

  // --- TZ 14-band: to'lov hisobi ----------------------------
  describe("TZ 14-band — to'lov hisobi", () => {
    it("totalPrice = pricePerNight × nights + charges", async () => {
      const { body } = await api("/api/reservations");
      for (const r of body) {
        const nights = Math.max(
          1,
          Math.round(
            (new Date(r.checkOut).getTime() - new Date(r.checkIn).getTime()) / 86_400_000
          )
        );
        const chargesTotal = r.charges.reduce((s: number, c: any) => s + c.amount, 0);
        expect(r.totalPrice).toBeCloseTo(r.pricePerNight * nights + chargesTotal, 2);
      }
    });

    it("remainingAmount = max(total - paid, 0)", async () => {
      const { body } = await api("/api/reservations");
      for (const r of body) {
        const paid = r.payments.reduce((s: number, p: any) => s + p.amount, 0);
        expect(r.paidAmount).toBeCloseTo(paid, 2);
        expect(r.remainingAmount).toBeCloseTo(Math.max(r.totalPrice - paid, 0), 2);
      }
    });
  });

  // --- TZ 2-band: sakkiz amal -------------------------------
  describe("TZ 2-band — bron amallari", () => {
    let id: string;

    it("1. bron yaratish", async () => {
      const { status, body } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "111",
          guestName: "Vitest Mehmon",
          phone: "+998900000001",
          checkIn: day(40),
          checkOut: day(43),
          adults: 2,
          source: "direct",
          pricePerNight: 35,
          initialPayment: 50,
        }),
      });
      expect(status).toBe(201);
      expect(body.status).toBe("confirmed");
      expect(body.totalPrice).toBe(105);      // 35 × 3
      expect(body.paidAmount).toBe(50);
      expect(body.remainingAmount).toBe(55);
      id = body.id;
    });

    it("2. bronni o'zgartirish (mehmon soni, narx)", async () => {
      const { body } = await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 3, pricePerNight: 40 }),
      });
      expect(body.adults).toBe(3);
      expect(body.pricePerNight).toBe(40);
      expect(body.totalPrice).toBe(120);      // 40 × 3
    });

    it("3. sana o'zgartirish", async () => {
      const { body } = await api(`/api/reservations/${id}/change-dates`, {
        method: "POST",
        body: JSON.stringify({ checkIn: day(40), checkOut: day(45) }),
      });
      expect(body.checkOut).toBe(day(45));
      expect(body.totalPrice).toBe(200);      // 40 × 5
    });

    it("4. xona almashtirish (tur o'zgaradi)", async () => {
      const { body } = await api(`/api/reservations/${id}/change-room`, {
        method: "POST",
        body: JSON.stringify({ roomId: "104" }),   // double — bugun bo'sh
      });
      expect(body.roomId).toBe("104");
      expect(body.syncStatus).toBe("pending");     // Beds24'ga yuborilishi kerak
    });

    it("5. to'lov qo'shish", async () => {
      const { status, body } = await api(`/api/reservations/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 100, method: "Karta" }),
      });
      expect(status).toBe(201);
      expect(body.paidAmount).toBe(150);
      expect(body.payments).toHaveLength(2);
    });

    it("6. xarajat qo'shish", async () => {
      const { body } = await api(`/api/reservations/${id}/charges`, {
        method: "POST",
        body: JSON.stringify({ label: "Minibar", amount: 20 }),
      });
      expect(body.totalPrice).toBe(220);       // 200 + 20
      expect(body.remainingAmount).toBe(70);
    });

    it("7. check-in — status va vaqt yoziladi", async () => {
      const { body } = await api(`/api/reservations/${id}/check-in`, { method: "POST" });
      expect(body.status).toBe("checked_in");
      expect(body.checkedInAt).toBeTruthy();
    });

    it("8. check-out — status va vaqt yoziladi", async () => {
      const { body } = await api(`/api/reservations/${id}/check-out`, { method: "POST" });
      expect(body.status).toBe("checked_out");
      expect(body.checkedOutAt).toBeTruthy();
    });

    it("bekor qilish — xona bo'shaydi", async () => {
      const { body } = await api(`/api/reservations/${id}/cancel`, { method: "POST" });
      expect(body.status).toBe("cancelled");
    });
  });

  // --- Room.status — JORIY holat, sanaga bog'liq emas -------
  describe("Room.status — joriy jismoniy holat", () => {
    it("kelajakdagi bron xona holatini o'zgartirmaydi", async () => {
      const { body: before } = await api("/api/rooms");
      const was = before.find((r: any) => r.id === "107").status;

      const { body: r } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "107",
          guestName: "Kelajak mehmoni",
          checkIn: day(120),
          checkOut: day(123),
          pricePerNight: 35,
        }),
      });

      const { body: after } = await api("/api/rooms");
      expect(after.find((x: any) => x.id === "107").status).toBe(was);

      await api(`/api/reservations/${r.id}/cancel`, { method: "POST" });
    });

    it("bugungi check-in → OCCUPIED, check-out → DIRTY", async () => {
      const { body: r } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "109",
          guestName: "Bugungi mehmon",
          checkIn: day(0),
          checkOut: day(2),
          pricePerNight: 35,
        }),
      });

      await api(`/api/reservations/${r.id}/check-in`, { method: "POST" });
      const { body: a } = await api("/api/rooms");
      expect(a.find((x: any) => x.id === "109").status).toBe("occupied");

      await api(`/api/reservations/${r.id}/check-out`, { method: "POST" });
      const { body: b } = await api("/api/rooms");
      expect(b.find((x: any) => x.id === "109").status).toBe("dirty");

      await api(`/api/reservations/${r.id}/cancel`, { method: "POST" });
    });
  });

  // --- TZ 3-band: overbooking -------------------------------
  describe("TZ 3-band — overbooking himoyasi", () => {
    let firstId: string;

    it("birinchi bron o'tadi", async () => {
      const { status, body } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "112",
          guestName: "Birinchi",
          checkIn: day(60),
          checkOut: day(63),
          pricePerNight: 40,
        }),
      });
      expect(status).toBe(201);
      firstId = body.id;
    });

    it("qoplanuvchi bron 409 bilan rad etiladi", async () => {
      const { status, body } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "112",
          guestName: "Ikkinchi",
          checkIn: day(61),      // kesishadi
          checkOut: day(65),
          pricePerNight: 40,
        }),
      });
      expect(status).toBe(409);
      expect(body.code).toBe("ROOM_UNAVAILABLE");
    });

    it("chegara '[)': checkOut kuni yangi bron kiradi", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "112",
          guestName: "Uchinchi",
          checkIn: day(63),      // birinchisi shu kuni chiqadi
          checkOut: day(66),
          pricePerNight: 40,
        }),
      });
      expect(status).toBe(201);
    });

    it("bekor qilingan bron xonani bo'shatadi", async () => {
      await api(`/api/reservations/${firstId}/cancel`, { method: "POST" });
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "112",
          guestName: "To'rtinchi",
          checkIn: day(60),
          checkOut: day(62),
          pricePerNight: 40,
        }),
      });
      expect(status).toBe(201);
    });
  });

  // --- Validatsiya ------------------------------------------
  describe("validatsiya", () => {
    it("checkOut <= checkIn bo'lsa 400", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "101",
          guestName: "X",
          checkIn: day(10),
          checkOut: day(10),
          pricePerNight: 35,
        }),
      });
      expect(status).toBe(400);
    });

    it("noto'g'ri sana formati 400", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "101",
          guestName: "X",
          checkIn: "12.09.2026",
          checkOut: day(12),
          pricePerNight: 35,
        }),
      });
      expect(status).toBe(400);
    });

    it("mavjud bo'lmagan xona 404", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "999",
          guestName: "X",
          checkIn: day(10),
          checkOut: day(12),
          pricePerNight: 35,
        }),
      });
      expect(status).toBe(404);
    });
  });

  // --- Bo'sh xonalar ----------------------------------------
  describe("bo'sh xonalarni qidirish", () => {
    it("band xona ro'yxatda yo'q", async () => {
      const { body } = await api(`/api/rooms/available?from=${day(80)}&to=${day(83)}`);
      expect(body.length).toBe(12);   // hech kim band qilmagan

      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "105",
          guestName: "Band qiluvchi",
          checkIn: day(80),
          checkOut: day(83),
          pricePerNight: 35,
        }),
      });

      const { body: after } = await api(`/api/rooms/available?from=${day(80)}&to=${day(83)}`);
      expect(after.length).toBe(11);
      expect(after.find((r: any) => r.id === "105")).toBeUndefined();
    });
  });

  // --- Narxlar (07 §8) --------------------------------------
  describe("narxlar — Q8 (qo'lda belgilanadi)", () => {
    it("RatePlan o'qiladi", async () => {
      const { body } = await api(`/api/rate-plans?from=${day(0)}&to=${day(2)}`);
      expect(body.length).toBeGreaterThan(0);
      expect(typeof body[0].price).toBe("number");
      expect(body[0].source).toBe("pms");
    });

    it("narx belgilanadi va sync kutadi", async () => {
      const { body } = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: day(100),
          to: day(102),
          prices: { standard: 45, deluxe: 65 },
        }),
      });
      expect(body.updated).toBe(6);          // 3 kun × 2 tur
      expect(body.syncStatus).toBe("pending");

      const { body: check } = await api(`/api/rate-plans?from=${day(100)}&to=${day(100)}`);
      const std = check.find((p: any) => p.roomTypeId === "standard");
      expect(std.price).toBe(45);
      expect(std.syncStatus).toBe("pending");
    });
  });
});
