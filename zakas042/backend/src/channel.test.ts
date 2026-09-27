/**
 * Channel manager — Beds24 KUZATUVI (faqat o'qish, faqat FOUNDER)
 *
 * 2026-09-27, egasi qarori: olib tashlangan Channel manager egasi uchun
 * qaytdi, lekin PMS Beds24'dan faqat O'QIYDI va solishtiradi. Bu testlar
 * uchta narsani isbotlaydi:
 *
 *   1. Faqat FOUNDER ko'radi — ADMIN, MANAGER, STAFF 403
 *   2. Ma'lumot TO'G'RI — Beds24 bronlari PMS bilan to'g'ri
 *      solishtiriladi, bo'sh joy/narx farqi to'g'ri topiladi
 *   3. Hech narsa YOZILMAYDI — Beds24'ga faqat GET boradi, PMS bronlari
 *      soni o'zgarmaydi
 *
 * Soxta Beds24 real API xulqini takrorlaydi (BEDS24.md, "Real API
 * faktlari"): refresh token almashinuvi, `includeAllRooms`, `include*`
 * bayroqlarisiz bo'sh kalendar, siqilgan oraliqlar, bekor qilinganlar
 * faqat so'ralganda, sahifalash, kredit sarlavhalari, unit id har turda
 * 1 dan.
 *
 * Server `BEDS24_BASE_URL` va `FX_CBU_URL` shu soxta serverga qarashi
 * kerak (zakas042/README.md, "Testlar"). Qaramasa testlar o'tkazib
 * yuboriladi.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { day, tariffFor } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const FAKE_URL = new URL(process.env.BEDS24_BASE_URL ?? "http://127.0.0.1:1/api/v2");
const FAKE_PORT = Number(FAKE_URL.port);
const WEBHOOK_TOKEN = process.env.WEBHOOK_URL_TOKEN ?? "";

// ============================================================
//  Soxta Beds24 + Markaziy bank
// ============================================================

type Booking = Record<string, unknown> & { id: number; roomId: number; status: string; arrival: string; departure: string };

const fake = {
  requests: [] as Array<{ method: string; path: string }>,
  refresh: new Set<string>(),
  access: new Set<string>(),
  seq: 0,
  bookings: [] as Booking[],
  /** roomId -> kun -> {numAvail, price1} */
  calendar: new Map<number, Map<string, { numAvail: number; price1?: number }>>(),
  cbuRate: "12500.00",
  pageSize: 2,
  credits: 100,
};

const PROPERTY = {
  id: 777,
  name: "Imron Hotel (soxta)",
  currency: "USD",
  roomTypes: [
    { id: 5001, name: "Room 1", qty: 1, maxPeople: 3, units: [{ id: 1, name: "101" }] },
    // Unit id yana 1 — faqat roomId bilan birga noyob (real API)
    { id: 5002, name: "Room 2", qty: 1, maxPeople: 2, units: [{ id: 1, name: "102" }] },
    { id: 5003, name: "Sinov", qty: 1, maxPeople: 2, units: [{ id: 1, name: "999" }] },
  ],
};

function send(res: http.ServerResponse, status: number, body: unknown) {
  fake.credits = Math.max(0, fake.credits - 1);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Five-Min-Limit-Remaining": String(fake.credits),
    "X-Five-Min-Limit-Resets-In": "250",
    "X-Request-Cost": "1",
  });
  res.end(JSON.stringify(body));
}

function issueTokens() {
  const n = ++fake.seq;
  const t = { token: `acc-${n}-secret`, refreshToken: `ref-${n}-secret`, expiresIn: 86_400 };
  fake.access.add(t.token);
  fake.refresh.add(t.refreshToken);
  return t;
}

/** Ketma-ket bir xil qiymatli kunlar bitta oraliq (real API shunday beradi) */
function compress(days: Array<[string, { numAvail: number; price1?: number }]>, withAvail: boolean, withPrice: boolean) {
  const out: Array<Record<string, unknown>> = [];
  for (const [date, v] of days.sort(([a], [b]) => a.localeCompare(b))) {
    const item: Record<string, unknown> = {};
    if (withAvail) item.numAvail = v.numAvail;
    if (withPrice && v.price1 !== undefined) item.price1 = v.price1;
    const last = out[out.length - 1];
    const next = last ? new Date(Date.parse(String(last.to) + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10) : "";
    if (last && next === date && last.numAvail === item.numAvail && last.price1 === item.price1) {
      last.to = date;
    } else {
      out.push({ from: date, to: date, ...item });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname.replace(FAKE_URL.pathname, "");
  fake.requests.push({ method: req.method ?? "", path });

  if (path === "/cbu") {
    return send(res, 200, [{ Ccy: "USD", Rate: fake.cbuRate, Nominal: "1", Date: "26.09.2026" }]);
  }
  if (req.method !== "GET") return send(res, 405, { success: false, error: "faqat GET kutilgan" });

  if (path === "/authentication/setup") {
    if (req.headers.code !== "INVITE-OK") return send(res, 400, { success: false, error: "Invalid code" });
    return send(res, 200, issueTokens());
  }
  if (path === "/authentication/token") {
    const r = String(req.headers.refreshtoken ?? "");
    if (!fake.refresh.has(r)) return send(res, 400, { success: false, error: "Token not valid" });
    fake.refresh.delete(r);                    // almashinuv: eskisi o'ladi
    return send(res, 200, issueTokens());
  }

  if (!fake.access.has(String(req.headers.token ?? ""))) {
    return send(res, 401, { success: false, error: "Token not valid" });
  }

  if (path === "/authentication/details") {
    return send(res, 200, { validToken: true, token: { expiresIn: 80_000, scopes: ["read:bookings", "read:inventory", "read:properties"] } });
  }
  if (path === "/properties") {
    const all = url.searchParams.get("includeAllRooms") === "true";
    return send(res, 200, { success: true, data: [{ ...PROPERTY, roomTypes: all ? PROPERTY.roomTypes : [] }] });
  }
  if (path === "/bookings") {
    const statuses = url.searchParams.getAll("status");
    const allowed = statuses.length ? statuses : ["confirmed", "request", "new", "black", "inquiry"];
    const depFrom = url.searchParams.get("departureFrom") ?? "0000";
    const list = fake.bookings.filter((b) => allowed.includes(b.status) && b.departure >= depFrom);
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = list.slice((page - 1) * fake.pageSize, page * fake.pageSize);
    return send(res, 200, { success: true, data: slice, pages: { nextPageExists: page * fake.pageSize < list.length } });
  }
  if (path === "/inventory/rooms/calendar") {
    const withAvail = url.searchParams.get("includeNumAvail") === "true";
    const withPrice = url.searchParams.get("includePrices") === "true";
    const start = url.searchParams.get("startDate") ?? "";
    const end = url.searchParams.get("endDate") ?? "";
    const data = [...fake.calendar.entries()].map(([roomId, days]) => ({
      roomId,
      propertyId: PROPERTY.id,
      calendar: withAvail || withPrice
        ? compress([...days.entries()].filter(([d]) => d >= start && d <= end), withAvail, withPrice)
        : [],
    }));
    return send(res, 200, { success: true, data });
  }
  return send(res, 404, { success: false, error: "not found" });
});

// ============================================================
//  Yordamchilar
// ============================================================

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${PMS}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

async function login(email: string): Promise<string> {
  const r = await api("/api/auth/login", { method: "POST", body: { email, password: "admin12345" } });
  return r.body?.token ?? "";
}

/**
 * 101-xona PMS'da band kunlari (faol bron yoki yopiq), 60 kunlik ufqda,
 * Beds24 "1 bo'sh" degan kunlar (day10–11 dan tashqari).
 */
async function busyDays101(): Promise<string[]> {
  const res = await prisma.reservation.findMany({
    where: { roomId: "101", status: { notIn: ["CANCELLED", "NO_SHOW"] } },
  });
  const out = new Set<string>();
  for (let n = 0; n < 60; n++) {
    if (n === 10 || n === 11) continue;
    const d = day(n);
    if (res.some((r) => r.checkIn.toISOString().slice(0, 10) <= d && r.checkOut.toISOString().slice(0, 10) > d)) out.add(d);
  }
  const blocked = await prisma.roomDayStatus.findMany({ where: { roomId: "101", isBlocked: true } });
  for (const b of blocked) {
    const d = b.date.toISOString().slice(0, 10);
    if (d >= day(0) && d < day(60) && d !== day(10) && d !== day(11)) out.add(d);
  }
  return [...out].sort();
}

let expectedOversell: string[] = [];
let authOn = false;
let fakeWired = false;
const tok = { founder: "", admin: "", manager: "", staff: "" };

function setCalendar(roomId: number, from: number, to: number, v: (n: number) => { numAvail: number; price1?: number }) {
  const m = fake.calendar.get(roomId) ?? new Map();
  for (let n = from; n <= to; n++) m.set(day(n), v(n));
  fake.calendar.set(roomId, m);
}

beforeAll(async () => {
  const health = await api("/health");
  authOn = health.body?.security?.auth === true;
  tok.founder = await login("founder@imron.local");
  tok.admin = await login("admin@imron.local");
  tok.manager = await login("manager@imron.local");
  tok.staff = await login("staff@imron.local");

  if (FAKE_URL.hostname === "127.0.0.1" && FAKE_PORT > 0) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(FAKE_PORT, "127.0.0.1", () => resolve());
    });
    const conn = await api("/api/admin/connection", { token: tok.founder });
    fakeWired = conn.body?.baseUrl === FAKE_URL.href.replace(/\/$/, "");
  }

  // Beds24 bronlari (real maydon nomlari bilan)
  fake.bookings = [
    { id: 9001, propertyId: 777, roomId: 5001, unitId: 1, status: "confirmed", arrival: day(10), departure: day(12),
      numAdult: 2, numChild: 0, price: 72, firstName: "Ali", lastName: "Valiyev", apiSource: "Booking.com",
      channel: "booking", apiReference: "BK-1001", bookingTime: "2026-09-20 10:00:00", modifiedTime: "2026-09-20 10:00:00" },
    { id: 9002, propertyId: 777, roomId: 5002, unitId: 1, status: "new", arrival: day(20), departure: day(22),
      numAdult: 3, numChild: 0, price: 80, firstName: "John", lastName: "Smith", channel: "direct",
      modifiedTime: "2026-09-21 09:00:00" },
    { id: 9003, propertyId: 777, roomId: 5001, unitId: 1, status: "cancelled", arrival: day(30), departure: day(31),
      numAdult: 1, price: 36, firstName: "Bekor", apiSource: "Booking.com", apiReference: "BK-1003" },
    { id: 9004, propertyId: 777, roomId: 5003, unitId: 1, status: "confirmed", arrival: day(5), departure: day(6),
      numAdult: 1, price: 30, firstName: "Sinov" },
    { id: 9005, propertyId: 777, roomId: 5001, unitId: 1, status: "confirmed", arrival: day(40), departure: day(42),
      numAdult: 2, price: 72, firstName: "Olim", apiSource: "Booking.com", apiReference: "BK-1005" },
    // O'tib ketgan — `departureFrom` filtri bilan kelmasligi kerak
    { id: 9000, propertyId: 777, roomId: 5001, unitId: 1, status: "confirmed", arrival: day(-5), departure: day(-3),
      numAdult: 1, price: 36, firstName: "Eski" },
  ];

  // Kalendar: Room 1 = 36$ (=450 000 so'm, PMS bilan mos), Room 2 = 40$
  // (=500 000, PMS 400 000 — farq). Beds24 bronlari kunlari numAvail 0
  setCalendar(5001, 0, 70, (n) => ({ numAvail: n >= 10 && n < 12 ? 0 : 1, price1: n === 55 ? undefined : 36 }));
  setCalendar(5002, 0, 70, (n) => ({ numAvail: n >= 20 && n < 22 ? 0 : 1, price1: 40 }));
}, 30_000);

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
});

// ============================================================
//  1. Faqat FOUNDER
// ============================================================

describe("Test muhiti", () => {
  it("BEDS24_BASE_URL sozlangan bo'lsa, server soxta Beds24'ga ulangan (testlar jim o'tkazib yuborilmasin)", () => {
    if (!process.env.BEDS24_BASE_URL) return;   // sozlanmagan — README'dagi eslatma
    expect(fakeWired, "server BEDS24_BASE_URL ni ko'rmayapti — test.env ni serverga ham bering").toBe(true);
  });
});

describe("Channel manager — faqat FOUNDER ko'radi", () => {
  const paths: Array<[string, string]> = [
    ["GET", "/api/admin/connection"],
    ["GET", "/api/admin/status"],
    ["GET", "/api/admin/channel-health"],
    ["GET", "/api/admin/mapping"],
    ["GET", "/api/admin/sync-log"],
    ["GET", "/api/admin/webhook-events"],
    ["GET", "/api/admin/channel/bookings"],
    ["GET", "/api/admin/rates"],
    ["GET", "/api/admin/fx"],
    ["GET", "/api/reservations/fx-rate"],
    ["POST", "/api/admin/maintenance/poll"],
    ["POST", "/api/admin/fx/refresh"],
    ["PUT", "/api/admin/fx"],
    ["POST", "/api/admin/connection"],
  ];

  it("ADMIN, MANAGER, STAFF — 403 (hech biri ko'rmaydi)", async () => {
    if (!authOn) return;   // AUTH_REQUIRED=false — ruxsat tekshirilmaydi
    for (const role of ["admin", "manager", "staff"] as const) {
      for (const [method, path] of paths) {
        const r = await api(path, { method, token: tok[role], body: method === "GET" ? undefined : {} });
        expect(r.status, `${role} ${method} ${path}`).toBe(403);
      }
    }
  });

  it("tokensiz — 401", async () => {
    if (!authOn) return;
    const r = await fetch(`${PMS}/api/admin/connection`, { headers: { Authorization: "Bearer x" } });
    expect(r.status).toBe(401);
  });

  it("FOUNDER — 200, rejim faqat o'qish", async () => {
    const r = await api("/api/admin/connection", { token: tok.founder });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("read-only");
    expect(r.body.connected).toBe(false);
  });

  it("OTA raqamini faqat FOUNDER kiritadi", async () => {
    if (!authOn) return;
    const r = await api("/api/reservations/x/external-ref", { method: "PUT", token: tok.admin, body: { externalReference: "BK-1" } });
    expect(r.status).toBe(403);
  });
});

// ============================================================
//  2. Dollar kursi
// ============================================================

describe("Dollar kursi — faqat ko'rsatish", () => {
  it("qo'lda kurs: chegaradan tashqari 400, to'g'risi saqlanadi", async () => {
    expect((await api("/api/admin/fx", { method: "PUT", token: tok.founder, body: { rate: 5 } })).status).toBe(400);
    const r = await api("/api/admin/fx", { method: "PUT", token: tok.founder, body: { rate: 12000 } });
    expect(r.status).toBe(200);
    expect(r.body.fx).toMatchObject({ rate: 12000, source: "manual" });
    const g = await api("/api/reservations/fx-rate", { token: tok.founder });
    expect(g.body.fx.rate).toBe(12000);
  });

  it("Markaziy bankdan olish — javob to'g'ri o'qiladi (Rate, Date)", async () => {
    if (!fakeWired) return;
    const r = await api("/api/admin/fx/refresh", { method: "POST", token: tok.founder });
    expect(r.status).toBe(200);
    expect(r.body.fx).toMatchObject({ rate: 12500, source: "cbu", date: "2026-09-26" });
  });
});

// ============================================================
//  3. Ulanish, mapping, bronlar, farq — soxta Beds24 bilan
// ============================================================

describe("Beds24 kuzatuvi — ma'lumot to'g'ri, hech narsa yozilmaydi", () => {
  let pmsBefore = 0;

  it("noto'g'ri invite code — 400, bazaga hech narsa yozilmaydi", async () => {
    if (!fakeWired) return;
    const r = await api("/api/admin/connection", { method: "POST", token: tok.founder, body: { inviteCode: "XATO-KOD" } });
    expect(r.status).toBe(400);
    expect(await prisma.channelConnection.count()).toBe(0);
  });

  it("noto'g'ri obyekt ID — 400 (boshqa obyektga jimgina ulanmaydi)", async () => {
    if (!fakeWired) return;
    const r = await api("/api/admin/connection", { method: "POST", token: tok.founder, body: { inviteCode: "INVITE-OK", propertyId: "999" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("999");
    expect(await prisma.channelConnection.count()).toBe(0);
  });

  it("ulanish: token shifrlangan, javobda token yo'q, ping ishlaydi", async () => {
    if (!fakeWired) return;
    pmsBefore = await prisma.reservation.count();
    const r = await api("/api/admin/connection", { method: "POST", token: tok.founder, body: { inviteCode: "INVITE-OK" } });
    expect(r.status).toBe(201);
    expect(r.body.connection).toMatchObject({ connected: true, propertyId: "777" });
    expect(r.body.ping).toMatchObject({ ok: true, propertyName: "Imron Hotel (soxta)", currency: "USD", roomTypes: 3, units: 3 });
    expect(r.body.ping.credits.remaining).toBeTypeOf("number");
    expect(r.text).not.toMatch(/secret/);

    const row = await prisma.channelConnection.findFirstOrThrow();
    expect(row.refreshToken).not.toMatch(/ref-/);          // shifrlangan
    expect(row.refreshToken.split(":")).toHaveLength(3);   // iv:tag:data
  });

  it("mapping: unit nomi = xona raqami bo'yicha avtomatik, 999 o'tkazib yuboriladi", async () => {
    if (!fakeWired) return;
    const ext = await api("/api/admin/mapping/external", { token: tok.founder });
    expect(ext.body.property.roomTypes.map((t: any) => t.id)).toEqual(["5001", "5002", "5003"]);

    const r = await api("/api/admin/mapping/auto-units", { method: "POST", token: tok.founder });
    expect(r.status).toBe(200);
    expect(r.body.mapped.map((m: any) => m.roomId).sort()).toEqual(["101", "102"]);
    expect(r.body.skipped).toEqual([{ externalRoomTypeId: "5003", externalUnitId: "1", unitName: "999" }]);

    // Unit 1 ikki turda — ikki xil xonaga
    const m = await api("/api/admin/mapping", { token: tok.founder });
    const byRoom = Object.fromEntries(m.body.mappings.map((x: any) => [x.roomId, x.externalRoomTypeId]));
    expect(byRoom).toEqual({ "101": "5001", "102": "5002" });
  });

  it("Hoziroq tekshirish: bronlar to'g'ri solishtiriladi (sahifalash, bekor qilinganlar)", async () => {
    if (!fakeWired) return;
    const r = await api("/api/admin/maintenance/poll", { method: "POST", token: tok.founder });
    expect(r.status).toBe(200);
    // 5 ta (o'tib ketgan 9000 kelmaydi), 3 sahifa
    expect(r.body).toMatchObject({ fetched: 5, missingInPms: 3, unmapped: 1, inactive: 1, matched: 0 });

    const list = await api("/api/admin/channel/bookings", { token: tok.founder });
    const by = Object.fromEntries(list.body.map((b: any) => [b.externalId, b]));
    expect(by["9001"]).toMatchObject({ matchStatus: "MISSING_IN_PMS", source: "Booking.com", apiReference: "BK-1001", guestName: "Ali Valiyev", price: 72, currency: "USD" });
    expect(by["9001"].priceUzs).toBe(72 * 12500);
    expect(by["9003"].matchStatus).toBe("INACTIVE");
    expect(by["9004"].matchStatus).toBe("UNMAPPED");
    expect(by["9000"]).toBeUndefined();
  });

  it("qabulxona bronni kiritsa — MOS; mehmon soni farq qilsa — FARQ", async () => {
    if (!fakeWired) return;
    const p101 = await tariffFor("101");
    const p102 = await tariffFor("102");
    const a = await api("/api/reservations", { method: "POST", body: {
      roomId: "101", guestName: "Ali Valiyev", phone: "+998901234567", checkIn: day(10), checkOut: day(12),
      adults: 2, source: "booking_com", pricePerNight: p101,
    } });
    expect(a.status).toBe(201);
    const b = await api("/api/reservations", { method: "POST", body: {
      roomId: "102", guestName: "John Smith", phone: "+998901234568", checkIn: day(20), checkOut: day(22),
      adults: 2, pricePerNight: p102,
    } });
    expect(b.status).toBe(201);

    // Beds24'ga so'rovsiz — faqat PMS bilan qayta solishtiriladi
    const list = await api("/api/admin/channel/bookings", { token: tok.founder });
    const by = Object.fromEntries(list.body.map((x: any) => [x.externalId, x]));
    expect(by["9001"]).toMatchObject({ matchStatus: "MATCHED", reservationId: a.body.id });
    expect(by["9001"].matchNote).toContain("BK-1001");       // OTA raqami kiritilmagan
    expect(by["9002"]).toMatchObject({ matchStatus: "MISMATCH", reservationId: b.body.id });
    expect(by["9002"].matchNote).toContain("kattalar: Beds24 3, PMS 2");

    // Founder OTA raqamini kiritadi — eslatma yo'qoladi
    const ref = await api(`/api/reservations/${a.body.id}/external-ref`, { method: "PUT", token: tok.founder, body: { externalReference: "BK-1001" } });
    expect(ref.status).toBe(200);
    expect(ref.body.externalReference).toBe("BK-1001");
    const info = await api(`/api/admin/channel/reservation/${a.body.id}`, { token: tok.founder });
    expect(info.body).toMatchObject({ found: true, booking: { externalId: "9001", matchStatus: "MATCHED", matchNote: null } });
    pmsBefore += 2;
  });

  it("OTA'da bekor qilingan, PMS'da faol — FARQ deb ko'rsatiladi", async () => {
    if (!fakeWired) return;
    const p = await tariffFor("101");
    const r = await api("/api/reservations", { method: "POST", body: {
      roomId: "101", guestName: "Bekor", phone: "+998901234569", checkIn: day(30), checkOut: day(31), pricePerNight: p,
    } });
    await api(`/api/reservations/${r.body.id}/external-ref`, { method: "PUT", token: tok.founder, body: { externalReference: "BK-1003" } });
    pmsBefore += 1;
    const list = await api("/api/admin/channel/bookings", { token: tok.founder });
    const b = list.body.find((x: any) => x.externalId === "9003");
    expect(b.matchStatus).toBe("MISMATCH");
    expect(b.matchNote).toContain("bekor qilingan, PMS'da hali faol");
  });

  it("kalendar va farq: ikki marta sotish xavfi, narx farqi, narxsiz kun", async () => {
    if (!fakeWired) return;
    // PMS'da 101 band (day50), Beds24 esa 1 ta bo'sh deb sotmoqda
    const p = await tariffFor("101");
    const r = await api("/api/reservations", { method: "POST", body: {
      roomId: "101", guestName: "PMS mehmoni", phone: "+998901234570", checkIn: day(50), checkOut: day(51), pricePerNight: p,
    } });
    expect(r.status).toBe(201);
    pmsBefore += 1;

    const pull = await api("/api/admin/maintenance/pull-rates", { method: "POST", token: tok.founder });
    expect(pull.status).toBe(200);
    expect(pull.body.roomTypes).toBe(2);

    const d = await api("/api/admin/maintenance/drift", { method: "POST", token: tok.founder });
    expect(d.status).toBe(200);
    const over = d.body.issues.filter((i: any) => i.kind === "OVERSELL_RISK");
    // Kutilgan natija PMS'ning O'ZIDAN hisoblanadi: 101 band bo'lgan har
    // kun (seed mehmonlari ham), Beds24 esa o'sha kuni 1 bo'sh desa
    expectedOversell = await busyDays101();
    expect(expectedOversell).toEqual(expect.arrayContaining([day(30), day(50)]));
    expect(over.map((i: any) => i.date).sort()).toEqual(expectedOversell);
    expect(over.every((i: any) => i.externalRoomTypeId === "5001" && i.beds24 === 1 && i.pms === 0)).toBe(true);

    // Room 2: 40$ x 12 500 = 500 000, PMS 400 000 — har kun farq
    const diff = d.body.issues.filter((i: any) => i.kind === "PRICE_DIFF");
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((i: any) => i.externalRoomTypeId === "5002" && i.beds24 === 500_000 && i.pms === 400_000)).toBe(true);

    // Room 1 narxi mos (36$ = 450 000), faqat day55 da narx yo'q
    const missing = d.body.issues.filter((i: any) => i.kind === "PRICE_MISSING");
    expect(missing.map((i: any) => i.date)).toEqual([day(55)]);
    expect(d.body.undersell).toBe(0);
  });

  it("Narxlar sahifasi: $ va Beds24 belgilari to'g'ri", async () => {
    if (!fakeWired) return;
    const r = await api(`/api/admin/rates?from=${day(1)}&to=${day(3)}`, { token: tok.founder });
    expect(r.status).toBe(200);
    const t101 = r.body.types.find((t: any) => t.roomTypeId === "comfort3");
    const t102 = r.body.types.find((t: any) => t.roomTypeId === "standard3");
    expect(t101.beds24[0]).toMatchObject({ externalRoomTypeId: "5001", name: "Room 1" });
    expect(t101.days[day(1)]).toMatchObject({ pms: 450_000, usd: 36, beds24: 36, beds24Uzs: 450_000, status: "ok" });
    expect(t102.days[day(1)]).toMatchObject({ pms: 400_000, usd: 32, beds24: 40, status: "diff" });
    const other = r.body.types.find((t: any) => t.roomTypeId === "premium4");
    expect(other.days[day(1)].status).toBe("none");
  });

  it("access token eskirsa — yangilanadi, almashgan refresh token saqlanadi", async () => {
    if (!fakeWired) return;
    const refreshes = () => fake.requests.filter((r) => r.path === "/authentication/token").length;
    const before = refreshes();
    for (let i = 0; i < 2; i++) {
      fake.access.clear();                      // Beds24 hamma access tokenni bekor qildi
      const r = await api("/api/admin/connection/ping", { method: "POST", token: tok.founder });
      expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    }
    // Aynan ikki yangilash va ikkalasi ham o'tdi: fake eski refresh tokenni
    // o'ldiradi, ya'ni 2-yangilash faqat 1-sida kelgan YANGI token saqlangan
    // bo'lsagina ishlaydi
    expect(refreshes() - before).toBe(2);
  });

  it("Beds24'da o'chirilgan bron — keyingi o'qishda 'bron emas' bo'ladi (yolg'on signal yo'q)", async () => {
    if (!fakeWired) return;
    const removed = fake.bookings.find((b) => b.id === 9005)!;
    fake.bookings = fake.bookings.filter((b) => b.id !== 9005);
    const r = await api("/api/admin/maintenance/poll", { method: "POST", token: tok.founder });
    expect(r.body.deletedInBeds24).toBe(1);
    const list = await api("/api/admin/channel/bookings", { token: tok.founder });
    const b = list.body.find((x: any) => x.externalId === "9005");
    expect(b).toMatchObject({ status: "deleted", matchStatus: "INACTIVE" });
    // Qaytib kelsa (qayta tiklangan) — yana faol
    fake.bookings.push(removed);
    await api("/api/admin/maintenance/poll", { method: "POST", token: tok.founder });
    const again = await api("/api/admin/channel/bookings", { token: tok.founder });
    expect(again.body.find((x: any) => x.externalId === "9005").matchStatus).toBe("MISSING_IN_PMS");
  });

  it("xulosa (hisobot kartasi) to'g'ri raqamlarni beradi", async () => {
    if (!fakeWired) return;
    const s = await api("/api/admin/status", { token: tok.founder });
    expect(s.status).toBe(200);
    expect(s.body.connection.connected).toBe(true);
    expect(s.body.mapping).toMatchObject({ unitLevel: 2, isComplete: false });
    expect(s.body.bookings).toMatchObject({ matched: 1, mismatch: 2, missingInPms: 1, unmapped: 1 });
    expect(s.body.bookings.missing.map((b: any) => b.externalId)).toEqual(["9005"]);
    expect(s.body.drift).toMatchObject({ oversellRisk: expectedOversell.length, priceMissing: 1 });
    expect(s.body.fx.rate).toBe(12500);
  });

  it("webhook: noto'g'ri token 404; to'g'risi jurnalga yoziladi; takror e'tiborsiz", async () => {
    if (!fakeWired || !WEBHOOK_TOKEN) return;
    const payload = {
      timeStamp: "2026-09-27T10:00:00Z",
      booking: { id: 9006, propertyId: 777, roomId: 5002, unitId: 1, status: "confirmed", arrival: day(60), departure: day(61),
        numAdult: 1, price: 32, firstName: "Web", lastName: "Hook", apiSource: "Booking.com", apiReference: "BK-1006",
        bookingTime: "2026-09-27 10:00:00", modifiedTime: "2026-09-27 10:00:00" },
      invoiceItems: [],
    };
    expect((await api("/api/webhooks/beds24/notogri-token-000000", { method: "POST", body: payload })).status).toBe(404);

    const ok = await api(`/api/webhooks/beds24/${WEBHOOK_TOKEN}`, { method: "POST", body: payload });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("PROCESSED");
    const dup = await api(`/api/webhooks/beds24/${WEBHOOK_TOKEN}`, { method: "POST", body: payload });
    expect(dup.body.status).toBe("IGNORED_DUPLICATE");

    const ev = await api("/api/admin/webhook-events", { token: tok.founder });
    expect(ev.body).toHaveLength(1);
    expect(ev.body[0]).toMatchObject({ eventType: "booking.new", externalId: "9006", status: "PROCESSED" });
    const list = await api("/api/admin/channel/bookings?match=MISSING_IN_PMS", { token: tok.founder });
    expect(list.body.map((b: any) => b.externalId)).toContain("9006");
  });

  it("hech narsa YOZILMADI: Beds24'ga faqat GET, PMS bronlari o'zgarmadi", async () => {
    if (!fakeWired) return;
    const beds24 = fake.requests.filter((r) => r.path !== "/cbu");
    expect(beds24.length).toBeGreaterThan(5);
    expect(beds24.filter((r) => r.method !== "GET")).toEqual([]);
    // Faqat testning o'zi qo'shgan bronlar
    expect(await prisma.reservation.count()).toBe(pmsBefore);
  });

  it("sinxronizatsiya jurnali har amalni yozgan", async () => {
    if (!fakeWired) return;
    const r = await api("/api/admin/sync-log?limit=100", { token: tok.founder });
    const actions = new Set(r.body.map((x: any) => x.action));
    for (const a of ["connect", "ping", "poll_bookings", "pull_rates", "drift_check", "fx_refresh", "webhook_received"]) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(r.text).not.toMatch(/secret/);
  });

  it("ulanishni o'chirish — tokenlar bazadan o'chadi, tekshiruv 400", async () => {
    if (!fakeWired) return;
    const r = await api("/api/admin/connection", { method: "DELETE", token: tok.founder });
    expect(r.body.disconnected).toBe(1);
    const row = await prisma.channelConnection.findFirstOrThrow();
    expect(row).toMatchObject({ isActive: false, refreshToken: "", accessToken: null });
    expect((await api("/api/admin/maintenance/poll", { method: "POST", token: tok.founder })).status).toBe(400);
  });
});
