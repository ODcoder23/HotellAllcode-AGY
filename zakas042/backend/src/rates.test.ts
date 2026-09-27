/**
 * Narxlar va to'lov hisobi
 *
 * TZ 7-band:  narx admin tomonidan qo'lda belgilanadi (mijoz qarori Q8:
 *             avtomatik o'suvchi narx mexanizmi YO'Q).
 * TZ 14-band: to'lov hisob-kitobi — "To'liq to'langan / Qarz bor".
 *
 * Narx xona turi x kun, so'mda. Sayt, Shaxmatka va yangi bronlar shu
 * jadvaldan hisoblaydi.
 *
 * Ishga tushirish:  npx vitest run src/rates.test.ts
 * Shart: server, PostgreSQL (test bazasi)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { fromDateKey } from "./lib/serialize.js";
import { TYPES, loadTypes } from "./testUtils.js";

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

/** Narxlarni API orqali o'qiydi (Narxlar paneli shunday o'qiydi) */
async function readPrices(typeId: string, from: string, to: string): Promise<Array<{ date: string; price: number }>> {
  const res = await api(`/api/rate-plans?from=${from}&to=${to}`);
  expect(res.status).toBe(200);
  return (res.body as any[]).filter((r) => r.roomTypeId === typeId).map((r) => ({ date: r.date, price: r.price }));
}

/** Test oraliqlari 2031 yilda — seed narxlari va bronlariga tegmaydi */
const FAR = fromDateKey("2031-01-01");

async function cleanFar() {
  await prisma.reservation.deleteMany({ where: { checkIn: { gte: FAR } } });
  await prisma.ratePlan.deleteMany({ where: { date: { gte: FAR } } });
}

describe("Narxlar va to'lov (TZ 7, 14-band)", () => {
  beforeAll(async () => {
    await loadTypes();
    await cleanFar();
  });

  afterAll(cleanFar);

  describe("narx belgilash — admin qo'lda (Q8)", () => {
    it("PUT /api/rate-plans oraliqdagi har kunga narx yozadi", async () => {
      const res = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: "2031-03-01",
          to: "2031-03-03",
          prices: { [TYPES.a]: 450_000 },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(3);       // 01, 02, 03

      const days = await readPrices(TYPES.a, "2031-03-01", "2031-03-03");
      expect(days).toHaveLength(3);
      expect(days.every((d) => d.price === 450_000)).toBe(true);
    });

    it("qayta belgilash eski narxni almashtiradi (dublikat yo'q)", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-10", to: "2031-03-11", prices: { [TYPES.c]: 800_000 } }),
      });
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-10", to: "2031-03-11", prices: { [TYPES.c]: 950_000 } }),
      });

      const days = await readPrices(TYPES.c, "2031-03-10", "2031-03-11");
      expect(days).toHaveLength(2);
      expect(days.every((d) => d.price === 950_000)).toBe(true);
      const rows = await prisma.ratePlan.count({
        where: { roomTypeId: TYPES.c, date: { gte: fromDateKey("2031-03-10"), lte: fromDateKey("2031-03-11") } },
      });
      expect(rows).toBe(2);
    });

    it("mavsumiy narx: faqat tanlangan hafta kunlari yoziladi (Narxlar bo'limi)", async () => {
      // 2031-03-03 — dushanba. Faqat juma (5) va shanba (6)
      const res = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: "2031-03-03", to: "2031-03-09", prices: { [TYPES.a]: 777_000 }, weekdays: [5, 6],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(2);

      const days = await readPrices(TYPES.a, "2031-03-03", "2031-03-09");
      const set = days.filter((d) => d.price === 777_000).map((d) => d.date);
      expect(set).toEqual(["2031-03-07", "2031-03-08"]);
    });

    it("noma'lum tur, uzun oraliq, 0 narx va yo'q kun tushunarli xato beradi", async () => {
      const unknown = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-03", to: "2031-03-03", prices: { "yoq-tur": 500_000 } }),
      });
      expect(unknown.status).toBe(400);
      expect(String(unknown.body.error)).toContain("yoq-tur");

      const long = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-01-01", to: "2032-06-01", prices: { [TYPES.a]: 500_000 } }),
      });
      expect(long.status).toBe(400);

      // 0 — "sotilmaydi" degani; tasodifiy bo'sh maydon mavsumni o'chirmasin
      const zero = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-03", to: "2031-03-03", prices: { [TYPES.a]: 0 } }),
      });
      expect(zero.status).toBe(400);

      const noDays = await api("/api/rate-plans", {
        method: "PUT",
        // 1 kunlik oraliq (dushanba), faqat yakshanba so'ralgan
        body: JSON.stringify({ from: "2031-03-03", to: "2031-03-03", prices: { [TYPES.a]: 500_000 }, weekdays: [0] }),
      });
      expect(noDays.status).toBe(400);
    });

    it("noto'g'ri yoki mavjud bo'lmagan sana 400 beradi (500 emas)", async () => {
      const bad = await api("/api/rate-plans?from=2031-02-30&to=2031-03-01");
      expect(bad.status).toBe(400);
      const garbage = await api("/api/rate-plans?from=abc&to=2031-03-01");
      expect(garbage.status).toBe(400);
      const put = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-02-29", to: "2031-03-01", prices: { [TYPES.a]: 500_000 } }),
      });
      expect(put.status).toBe(400);
    });

    it("GET faqat narxni qaytaradi — Beds24 sinxron maydonlari yo'q", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-20", to: "2031-03-20", prices: { [TYPES.b]: 600_000 } }),
      });

      const res = await api("/api/rate-plans?from=2031-03-20&to=2031-03-20");
      const row = res.body.find((r: any) => r.roomTypeId === TYPES.b);
      expect(row).toBeTruthy();
      expect(row.price).toBe(600_000);
      expect(row.syncStatus).toBeUndefined();
      expect(row.source).toBeUndefined();
    });

    it("narx audit jurnaliga yoziladi", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-04-01", to: "2031-04-01", prices: { [TYPES.b]: 610_000 } }),
      });
      const log = await prisma.auditLog.findFirst({
        where: { action: "rate.changed", entityId: "2031-04-01..2031-04-01" },
      });
      expect(log).toBeTruthy();
    });
  });

  describe("to'lov hisob-kitobi (TZ 14-band)", () => {
    const findRoom = async () => {
      const room = await prisma.room.findFirst({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { number: "asc" },
      });
      if (!room) throw new Error("xona yo'q");
      return room;
    };

    const book = async (checkIn: string, checkOut: string, name: string, phone: string) => {
      const room = await findRoom();
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id, checkIn, checkOut, guestName: name, phone, adults: 1, pricePerNight: 100_000,
        }),
      });
      expect(created.status).toBe(201);
      return created.body;
    };

    it("to'lovsiz bron: paidAmount 0, qarz to'liq", async () => {
      const r = await book("2031-12-01", "2031-12-03", "Qarz Testi", "+99892700001");
      expect(r.totalPrice).toBe(200_000);
      expect(r.paidAmount).toBe(0);
      expect(r.remainingAmount).toBe(200_000);   // "Qarz bor"
    });

    it("qisman to'lov: qarz kamayadi", async () => {
      const r = await book("2031-12-10", "2031-12-12", "Qisman Testi", "+99892700002");
      const paid = await api(`/api/reservations/${r.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 120_000, method: "Naqd" }),
      });
      expect(paid.status).toBe(201);
      expect(paid.body.paidAmount).toBe(120_000);
      expect(paid.body.remainingAmount).toBe(80_000);
    });

    it("to'liq to'lov: qarz 0 — 'To'liq to'langan'; ortig'i rad etiladi", async () => {
      const r = await book("2031-12-20", "2031-12-22", "Toliq Testi", "+99892700003");
      const paid = await api(`/api/reservations/${r.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 200_000, method: "Karta" }),
      });
      expect(paid.body.paidAmount).toBe(200_000);
      expect(paid.body.remainingAmount).toBe(0);

      const extra = await api(`/api/reservations/${r.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 1_000, method: "Naqd" }),
      });
      expect(extra.status).toBe(400);
    });

    it("xizmat qo'shilsa qarz oshadi", async () => {
      const r = await book("2031-12-25", "2031-12-26", "Xarajat Testi", "+99892700004");
      const withCharge = await api(`/api/reservations/${r.id}/charges`, {
        method: "POST",
        body: JSON.stringify({ label: "Minibar", amount: 25_000 }),
      });
      expect(withCharge.status).toBe(201);
      expect(withCharge.body.totalPrice).toBe(125_000);
      expect(withCharge.body.remainingAmount).toBe(125_000);
    });

    it("to'lov qaytarilsa qarz qayta oshadi; ikkinchi marta qaytarib bo'lmaydi", async () => {
      const r = await book("2031-12-28", "2031-12-29", "Qaytarish Testi", "+99892700005");
      const paid = await api(`/api/reservations/${r.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 100_000, method: "Naqd" }),
      });
      expect(paid.body.remainingAmount).toBe(0);

      const paymentId = paid.body.payments[0].id;
      const reversed = await api(`/api/reservations/${r.id}/payments/${paymentId}/reverse`, { method: "POST" });
      expect(reversed.status).toBe(200);
      expect(reversed.body.paidAmount).toBe(0);
      expect(reversed.body.remainingAmount).toBe(100_000);

      const again = await api(`/api/reservations/${r.id}/payments/${paymentId}/reverse`, { method: "POST" });
      expect(again.status).toBe(400);
    });

    it("ikki to'lovli bronda bitta to'lovni ikki marta qaytarib bo'lmaydi (2026-09-27)", async () => {
      // Xato: tekshiruv faqat "qaytarish <= jami to'langan" edi — 100 000 +
      // 100 000 to'lovda birinchisi ikki marta qaytarilib, ikkinchisi yo'qolardi
      const r = await book("2031-10-05", "2031-10-07", "Ikki Tolov", "+99892700007");
      await api(`/api/reservations/${r.id}/payments`, { method: "POST", body: JSON.stringify({ amount: 100_000, method: "Naqd" }) });
      const two = await api(`/api/reservations/${r.id}/payments`, { method: "POST", body: JSON.stringify({ amount: 100_000, method: "Karta" }) });
      const first = two.body.payments.find((p: any) => p.method === "Naqd").id;

      const once = await api(`/api/reservations/${r.id}/payments/${first}/reverse`, { method: "POST" });
      expect(once.status).toBe(200);
      expect(once.body.paidAmount).toBe(100_000);

      const twice = await api(`/api/reservations/${r.id}/payments/${first}/reverse`, { method: "POST" });
      expect(twice.status).toBe(400);
      const card = await api(`/api/reservations/${r.id}`);
      expect(card.body.paidAmount).toBe(100_000);          // Karta to'lovi joyida

      // Parallel qaytarish ham faqat bittasi o'tadi
      const other = card.body.payments.find((p: any) => p.method === "Karta" && p.amount > 0).id;
      const results = await Promise.all(Array.from({ length: 4 }, () =>
        api(`/api/reservations/${r.id}/payments/${other}/reverse`, { method: "POST" })));
      expect(results.filter((x) => x.status === 200)).toHaveLength(1);
      expect((await api(`/api/reservations/${r.id}`)).body.paidAmount).toBe(0);
    });

    it("qabulxona (STAFF) to'lovni qaytara olmaydi — 403 (2026-09-27)", async () => {
      const health = await api("/health");
      if (health.body?.security?.auth !== true) return;   // AUTH o'chiq — rol tekshirilmaydi
      const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "staff@imron.local", password: "admin12345" }) });
      const staff = { Authorization: `Bearer ${login.body.token}` };

      const r = await book("2031-10-15", "2031-10-16", "Staff Qaytarish", "+99892700008");
      const paid = await api(`/api/reservations/${r.id}/payments`, {
        method: "POST", headers: staff, body: JSON.stringify({ amount: 50_000, method: "Naqd" }),
      });
      expect(paid.status).toBe(201);                       // qabul qilish — mumkin
      const pid = paid.body.payments[0].id;

      expect((await api(`/api/reservations/${r.id}/payments/${pid}/reverse`, { method: "POST", headers: staff })).status).toBe(403);
      expect((await api(`/api/reservations/${r.id}/payments`, {
        method: "POST", headers: staff, body: JSON.stringify({ amount: -50_000, method: "Naqd" }),
      })).status).toBe(403);
      expect((await api(`/api/reservations/${r.id}`)).body.paidAmount).toBe(50_000);
    });

    it("parallel to'lovlar qarzdan oshib ketmaydi (poyga holati)", async () => {
      // 2026-09-26 TUZATISH: ikki kassir bir vaqtda to'liq summani
      // kiritsa, ikkalasi ham o'tib bron ikki marta to'lanardi
      const r = await book("2031-11-01", "2031-11-03", "Parallel Tolov", "+99892700006");
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        api(`/api/reservations/${r.id}/payments`, {
          method: "POST",
          body: JSON.stringify({ amount: 200_000, method: "Naqd" }),
        })
      ));
      expect(results.filter((x) => x.status === 201)).toHaveLength(1);
      expect(results.filter((x) => x.status === 400)).toHaveLength(4);

      const card = await api(`/api/reservations/${r.id}`);
      expect(card.body.paidAmount).toBe(200_000);
      expect(card.body.refundDue).toBe(0);
    });

    it("mavjud bo'lmagan bronga to'lov — 404", async () => {
      const res = await api(`/api/reservations/yoq-bron-id/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 1_000, method: "Naqd" }),
      });
      expect(res.status).toBe(404);
    });
  });
});
