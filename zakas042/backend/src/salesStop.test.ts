/**
 * Tizim nazorati — sotuvni vaqtincha to'xtatish (STOP, 2026-09-26)
 *
 * Egasi talabi: mehmonxona dam olsa / ishlamasa STOP bosiladi, "Barcha
 * xonalar" tanlanadi va tasdiqlanadi — sayt va qabulxona yangi bron
 * qabul qilmaydi ("band"), Shaxmatka xiralashadi.
 * Faqat "Stopdan chiqarish" qayta ochadi. Mavjud bronlar saqlanadi.
 *
 * Shart: server + ALOHIDA test bazasi (vitest.setup.ts).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "./lib/prisma.js";
import { realRooms } from "./testUtils.js";
import { enforceSalesStop, STOP_REASON_PREFIX } from "./services/salesStop.js";
import { unblockRooms } from "./services/roomBlocking.js";
import { fromDateKey } from "./lib/serialize.js";

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

/** Bugundan n kun keyin — mehmonxona (Toshkent) kuni, server `hotelToday` bilan bir xil */
const k = (n: number) => {
  const t = new Date(Date.now() + 5 * 3_600_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n)).toISOString().slice(0, 10);
};

let rooms: Awaited<ReturnType<typeof realRooms>> = [];
const created: string[] = [];

async function book(roomId: string, from: number, to: number, price = 900_000) {
  const r = await api("/api/reservations", {
    method: "POST",
    body: JSON.stringify({
      roomId, guestName: "Stop Testi", phone: "+998900007777", adults: 1,
      checkIn: k(from), checkOut: k(to), pricePerNight: price,
    }),
  });
  if (r.status === 201) created.push(r.body.id);
  return r;
}

async function stopAll(reason = "Dam olish kunlari") {
  return api("/api/admin/sales-stop", { method: "POST", body: JSON.stringify({ allRooms: true, reason }) });
}

describe("STOP — sotuvni vaqtincha to'xtatish (tizim nazorati)", () => {
  beforeAll(async () => {
    rooms = await realRooms();
  });

  afterEach(async () => {
    // Stop qolib ketmasin — keyingi testlar sotuvni ochiq ko'rsin
    const st = await api("/api/admin/sales-stop");
    if (st.body?.active) await api("/api/admin/sales-stop/release", { method: "POST", body: "{}" });
    if (created.length > 0) {
      await prisma.payment.deleteMany({ where: { reservationId: { in: created } } });
      await prisma.reservation.deleteMany({ where: { id: { in: created } } });
      created.length = 0;
    }
    await prisma.roomDayStatus.deleteMany({ where: { blockReason: "Ta'mir (stop testi)" } });
  });

  it("barcha xonalar: sayt va qabulxona bron qila olmaydi, mavjud bron saqlanadi; stopdan chiqarish ochadi", async () => {
    const [roomA, roomB] = rooms;
    const existing = await book(roomA.id, 20, 22);
    expect(existing.status).toBe(201);

    // Oldindan ta'mirga yopilgan kun — STOP unga tegmasligi kerak
    await prisma.roomDayStatus.upsert({
      where: { roomId_date: { roomId: roomB.id, date: fromDateKey(k(30)) } },
      create: { roomId: roomB.id, date: fromDateKey(k(30)), isBlocked: true, blockReason: "Ta'mir (stop testi)" },
      update: { isBlocked: true, blockReason: "Ta'mir (stop testi)" },
    });

    const stop = await stopAll();
    expect(stop.status).toBe(201);
    expect(stop.body.stop).toMatchObject({ active: true, allRooms: true, reason: "Dam olish kunlari" });
    expect(stop.body.keptBookings).toBeGreaterThanOrEqual(1);
    expect(stop.body.status.stoppedRooms.length).toBe(rooms.length);

    // Sayt: hamma tur "band"
    const search = await api(`/api/public/availability?from=${k(40)}&to=${k(42)}&adults=1`);
    expect(search.status).toBe(200);
    expect(search.body.roomTypes.every((t: any) => t.availableCount === 0)).toBe(true);

    // Sayt broni — aniq xabar
    const pub = await api("/api/public/reservations", {
      method: "POST",
      body: JSON.stringify({
        roomTypeId: roomA.type, checkIn: k(40), checkOut: k(42), adults: 1,
        guest: { fullName: "Mehmon Stop", phone: "+998900008888" },
      }),
    });
    expect(pub.status).toBe(409);
    expect(String(pub.body.error)).toContain("vaqtincha");

    // Qabulxona — rad
    const rec = await book(roomA.id, 40, 42);
    expect(rec.status).toBe(409);
    expect(String(rec.body.error)).toContain("STOP");

    // Mavjud bron kunlari yopilmagan, to'lov ishlaydi
    const busyDays = await prisma.roomDayStatus.count({
      where: { roomId: roomA.id, date: { in: [fromDateKey(k(20)), fromDateKey(k(21))] }, isBlocked: true },
    });
    expect(busyDays).toBe(0);
    const pay = await api(`/api/reservations/${existing.body.id}/payments`, {
      method: "POST", body: JSON.stringify({ amount: 100_000, method: "Naqd" }),
    });
    expect(pay.status).toBe(201);

    // Bo'sh kunlar STOP bilan yopilgan, ta'mir kuni o'z sababida
    const stopDays = await prisma.roomDayStatus.count({
      where: { roomId: roomA.id, isBlocked: true, blockReason: { startsWith: STOP_REASON_PREFIX } },
    });
    expect(stopDays).toBeGreaterThan(300);
    const maint = await prisma.roomDayStatus.findUniqueOrThrow({
      where: { roomId_date: { roomId: roomB.id, date: fromDateKey(k(30)) } },
    });
    expect(maint.blockReason).toBe("Ta'mir (stop testi)");

    // Ikkinchi STOP — rad (avval stopdan chiqarish kerak)
    expect((await stopAll()).status).toBe(409);

    // Stopdan chiqarish
    const rel = await api("/api/admin/sales-stop/release", { method: "POST", body: "{}" });
    expect(rel.status).toBe(200);
    expect(rel.body.days).toBeGreaterThan(300);
    expect(rel.body.status.active).toBe(false);

    const again = await api(`/api/public/availability?from=${k(40)}&to=${k(42)}&adults=1`);
    expect(again.body.roomTypes.some((t: any) => t.availableCount > 0)).toBe(true);
    const leftStop = await prisma.roomDayStatus.count({
      where: { isBlocked: true, blockReason: { startsWith: STOP_REASON_PREFIX }, date: { gte: fromDateKey(k(0)) } },
    });
    expect(leftStop).toBe(0);
    // Ta'mir yopig'i qoldi
    const maint2 = await prisma.roomDayStatus.findUniqueOrThrow({
      where: { roomId_date: { roomId: roomB.id, date: fromDateKey(k(30)) } },
    });
    expect(maint2.isBlocked).toBe(true);

    expect((await book(roomA.id, 40, 42)).status).toBe(201);
  }, 60_000);

  it("ayrim xonalar: faqat tanlangan xona to'xtaydi", async () => {
    const [roomA, roomB] = rooms;
    const stop = await api("/api/admin/sales-stop", {
      method: "POST", body: JSON.stringify({ allRooms: false, roomIds: [roomA.id] }),
    });
    expect(stop.status).toBe(201);
    expect(stop.body.status.stoppedRooms).toEqual([roomA.id]);

    expect((await book(roomA.id, 45, 46)).status).toBe(409);
    expect((await book(roomB.id, 45, 46)).status).toBe(201);

    const otherBlocked = await prisma.roomDayStatus.count({
      where: { roomId: roomB.id, blockReason: { startsWith: STOP_REASON_PREFIX } },
    });
    expect(otherBlocked).toBe(0);
  }, 60_000);

  it("stop paytida bekor qilingan bron bo'shatgan kun catch-up'da yopiladi", async () => {
    const [roomA] = rooms;
    const res = await book(roomA.id, 50, 52);
    expect(res.status).toBe(201);
    expect((await stopAll()).status).toBe(201);

    // Mavjud bron bilan ishlash davom etadi — bekor qilish ham
    const cancel = await api(`/api/reservations/${res.body.id}/cancel`, { method: "POST", body: "{}" });
    expect(cancel.status).toBe(200);

    expect(await enforceSalesStop()).toBe(2);
    const freed = await prisma.roomDayStatus.count({
      where: {
        roomId: roomA.id, isBlocked: true, blockReason: { startsWith: STOP_REASON_PREFIX },
        date: { in: [fromDateKey(k(50)), fromDateKey(k(51))] },
      },
    });
    expect(freed).toBe(2);
    // Qayta chaqirish — o'zgarish yo'q
    expect(await enforceSalesStop()).toBe(0);
  }, 60_000);

  it("xonani qo'lda ochish STOP kunlariga tegmaydi", async () => {
    const [roomA] = rooms;
    expect((await stopAll()).status).toBe(201);
    await unblockRooms([roomA.id], { from: k(60), to: k(60) });
    const day = await prisma.roomDayStatus.findUniqueOrThrow({
      where: { roomId_date: { roomId: roomA.id, date: fromDateKey(k(60)) } },
    });
    expect(day.isBlocked).toBe(true);
    expect(day.blockReason?.startsWith(STOP_REASON_PREFIX)).toBe(true);
  }, 60_000);

  it("ayrim xona to'xtatilsa sayt shu turning boshqa xonasini sotadi", async () => {
    // Bir nechta xonali tur: bittasi STOP, qolgani sotuvda
    const byType = new Map<string, string[]>();
    for (const r of rooms) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
    const [typeId, ids] = [...byType.entries()].find(([, v]) => v.length >= 2)!;

    const stop = await api("/api/admin/sales-stop", {
      method: "POST", body: JSON.stringify({ allRooms: false, roomIds: [ids[0]], reason: "Ta'mir oldi" }),
    });
    expect(stop.status).toBe(201);

    const search = await api(`/api/public/availability?from=${k(120)}&to=${k(121)}&adults=1`);
    const offer = search.body.roomTypes.find((t: any) => t.id === typeId);
    expect(offer?.availableCount).toBe(ids.length - 1);

    const rel = await api("/api/admin/sales-stop/release", { method: "POST", body: "{}" });
    expect(rel.status).toBe(200);
    const again = await api(`/api/public/availability?from=${k(120)}&to=${k(121)}&adults=1`);
    expect(again.body.roomTypes.find((t: any) => t.id === typeId)?.availableCount).toBe(ids.length);
  }, 60_000);

  it("xona tanlanmasa rad etiladi; stop yo'q paytda chiqarish — 409", async () => {
    const none = await api("/api/admin/sales-stop", {
      method: "POST", body: JSON.stringify({ allRooms: false, roomIds: [] }),
    });
    expect(none.status).toBe(400);
    const rel = await api("/api/admin/sales-stop/release", { method: "POST", body: "{}" });
    expect(rel.status).toBe(409);
    const st = await api("/api/admin/sales-stop");
    expect(st.body.active).toBe(false);
  });
});
