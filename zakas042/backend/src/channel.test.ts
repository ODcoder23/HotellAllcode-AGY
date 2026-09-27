/**
 * Beds24 integratsiyasi (2026-09-27, "avvalgidek" qaytdi) — uchidan-uchiga
 *
 * Soxta Beds24 real API xulqini takrorlaydi (BEDS24.md, "Real API
 * faktlari"): refresh token almashinuvi, `includeAllRooms`, `include*`
 * bayroqlarisiz bo'sh kalendar, siqilgan oraliqlar, bekor qilinganlar
 * faqat so'ralganda, sahifalash, kredit sarlavhalari, unit id har turda
 * 1 dan, `checkAvailability` bilan joy yo'q bo'lsa rad etish.
 *
 * Isbotlanadi:
 *   1. Ruxsatlar: STAFF yopiq, MANAGER o'qiydi, ADMIN/FOUNDER boshqaradi
 *   2. Ulanish: invite code, token shifrlangan, refresh token almashinuvi
 *   3. Import: Beds24 bronlari PMS'ga (dollar, bron kursi, OTA raqami),
 *      bekor qilingan/bog'lanmagan/o'tmish kirmaydi, qo'lda kiritilgan
 *      OTA broni DUBLIKAT bo'lmaydi (bog'lanadi), `black` -> yopiq kun
 *   4. PMS -> Beds24: bron yuboriladi; joy yo'q bo'lsa REJECTED va
 *      avtomatik QAYTA YUBORILMAYDI (2026-09-26 dagi shovqin sababi)
 *   5. OTA qulfi (Q9), check-in belgisi, webhook, takror webhook
 *   6. Dollar bron: so'mda to'lov bron kursi bilan (Q15), STAFF $ ko'radi
 *   7. Yopish -> `black`, narx -> Beds24 ($), narx tortish, farq, kurs
 *
 * Server `BEDS24_BASE_URL`, `FX_CBU_URL` shu soxta serverga qarashi va
 * `POLL_INTERVAL_MINUTES=0` bo'lishi kerak (zakas042/README.md, "Testlar").
 * Qaramasa testlar o'tkazib yuboriladi.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { day } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const FAKE_URL = new URL(process.env.BEDS24_BASE_URL ?? "http://127.0.0.1:1/api/v2");
const FAKE_PORT = Number(FAKE_URL.port);
const WEBHOOK_TOKEN = process.env.WEBHOOK_URL_TOKEN ?? "";
const RATE = 12500;

// ============================================================
//  Soxta Beds24 + Markaziy bank
// ============================================================

type Booking = {
  id: number; propertyId: number; roomId: number; unitId?: number; status: string; subStatus?: string;
  arrival: string; departure: string; numAdult: number; numChild?: number; price?: number;
  firstName?: string; lastName?: string; apiSource?: string; channel?: string; apiReference?: string;
  referer?: string; flagText?: string; flagColor?: string; notes?: string;
  bookingTime?: string; modifiedTime: string;
};

const fake = {
  refresh: new Set<string>(),
  access: new Set<string>(),
  seq: 0,
  bookingSeq: 20_000,
  bookings: [] as Booking[],
  /** roomId -> kun -> {numAvail, price1} */
  calendar: new Map<number, Map<string, { numAvail?: number; price1?: number }>>(),
  posts: [] as Array<{ path: string; body: any }>,
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
    { id: 5002, name: "Room 2", qty: 1, maxPeople: 3, units: [{ id: 1, name: "102" }] },
    { id: 5003, name: "Sinov", qty: 1, maxPeople: 4, units: [{ id: 1, name: "999" }] },
  ],
};

const nowStamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

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
function compress(days: Array<[string, { numAvail?: number; price1?: number }]>, withAvail: boolean, withPrice: boolean) {
  const out: Array<Record<string, unknown>> = [];
  for (const [date, v] of days.sort(([a], [b]) => a.localeCompare(b))) {
    const item: Record<string, unknown> = {};
    if (withAvail) item.numAvail = v.numAvail;
    if (withPrice && v.price1 !== undefined) item.price1 = v.price1;
    const last = out[out.length - 1];
    const next = last ? new Date(Date.parse(String(last.to) + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10) : "";
    if (last && next === date && last.numAvail === item.numAvail && last.price1 === item.price1) last.to = date;
    else out.push({ from: date, to: date, ...item });
  }
  return out;
}

const active = (b: Booking) => b.status !== "cancelled" && b.status !== "inquiry";
const overlaps = (b: Booking, arrival: string, departure: string) => b.arrival < departure && b.departure > arrival;

/** Beds24 `checkAvailability`: unit berilsa aniq unit, bo'lmasa turdagi bo'sh unit bormi */
function hasRoom(roomId: number, unitId: number | undefined, arrival: string, departure: string, exceptId?: number): boolean {
  const busy = fake.bookings.filter((b) => b.id !== exceptId && b.roomId === roomId && active(b) && overlaps(b, arrival, departure));
  if (unitId) return !busy.some((b) => b.unitId === unitId);
  const qty = PROPERTY.roomTypes.find((r) => r.id === roomId)?.qty ?? 0;
  return busy.length < qty;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname.replace(FAKE_URL.pathname, "");

  if (path === "/cbu") {
    return send(res, 200, [{ Ccy: "USD", Rate: RATE.toFixed(2), Nominal: "1", Date: "26.09.2026" }]);
  }
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
    return send(res, 200, { validToken: true, token: { expiresIn: 80_000, scopes: ["all:bookings", "all:inventory", "read:properties"] } });
  }
  if (path === "/properties") {
    const all = url.searchParams.get("includeAllRooms") === "true";
    return send(res, 200, { success: true, data: [{ ...PROPERTY, roomTypes: all ? PROPERTY.roomTypes : [] }] });
  }

  if (path === "/bookings" && req.method === "GET") {
    const statuses = url.searchParams.getAll("status");
    const allowed = statuses.length ? statuses : ["confirmed", "request", "new", "black", "inquiry"];
    const depFrom = url.searchParams.get("departureFrom");
    const modFrom = url.searchParams.get("modifiedFrom");
    const id = url.searchParams.get("id");
    const list = fake.bookings.filter((b) =>
      allowed.includes(b.status) &&
      (!id || String(b.id) === id) &&
      (!depFrom || b.departure >= depFrom) &&
      (!modFrom || Date.parse(b.modifiedTime.replace(" ", "T") + "Z") >= Date.parse(modFrom))
    );
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = list.slice((page - 1) * fake.pageSize, page * fake.pageSize);
    return send(res, 200, { success: true, data: slice, pages: { nextPageExists: page * fake.pageSize < list.length } });
  }

  if (path === "/bookings" && req.method === "POST") {
    const body = (await readBody(req)) as Array<Record<string, any>>;
    fake.posts.push({ path, body });
    const out = (body ?? []).map((item) => {
      if (item.id) {
        const b = fake.bookings.find((x) => x.id === Number(item.id));
        if (!b) return { success: false, errors: [{ message: "booking not found" }] };
        for (const k of ["status", "subStatus", "arrival", "departure", "roomId", "unitId", "numAdult", "numChild",
          "price", "firstName", "lastName", "flagText", "flagColor", "notes"]) {
          if (item[k] !== undefined) (b as any)[k] = item[k];
        }
        b.modifiedTime = nowStamp();
        return { success: true, modified: { id: b.id } };
      }
      if (item.actions?.checkAvailability && !hasRoom(item.roomId, item.unitId, item.arrival, item.departure)) {
        return { success: false, errors: [{ field: "arrival", message: "No availability for selected dates" }] };
      }
      const b: Booking = {
        id: ++fake.bookingSeq, propertyId: PROPERTY.id, ...item,
        bookingTime: nowStamp(), modifiedTime: nowStamp(),
      } as Booking;
      delete (b as any).actions;
      fake.bookings.push(b);
      return { success: true, new: { id: b.id } };
    });
    return send(res, 201, out);
  }

  if (path === "/inventory/rooms/calendar" && req.method === "POST") {
    const body = (await readBody(req)) as Array<{ roomId: number; calendar: Array<Record<string, any>> }>;
    fake.posts.push({ path, body });
    for (const row of body ?? []) {
      const m = fake.calendar.get(row.roomId) ?? new Map();
      for (const c of row.calendar) {
        for (let d = c.from; d <= c.to; d = new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10)) {
          m.set(d, { ...m.get(d), ...(c.price1 !== undefined ? { price1: c.price1 } : {}), ...(c.numAvail !== undefined ? { numAvail: c.numAvail } : {}) });
        }
      }
      fake.calendar.set(row.roomId, m);
    }
    return send(res, 201, [{ success: true }]);
  }

  if (path === "/inventory/rooms/calendar") {
    const withAvail = url.searchParams.get("includeNumAvail") === "true";
    const withPrice = url.searchParams.get("includePrices") === "true";
    const start = url.searchParams.get("startDate") ?? "";
    const end = url.searchParams.get("endDate") ?? "";
    const only = url.searchParams.get("roomId");
    const data = [...fake.calendar.entries()]
      .filter(([roomId]) => !only || String(roomId) === only)
      .map(([roomId, days]) => ({
        roomId,
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

/** Shart bajarilguncha kutadi (navbat va fon ishlari uchun) */
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Kutilmadi: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const byExternal = (id: number | string) =>
  prisma.reservation.findFirst({ where: { externalReservationId: String(id) } });

let authOn = false;
let fakeWired = false;
const tok = { founder: "", admin: "", manager: "", staff: "" };

function book(b: Partial<Booking> & Pick<Booking, "id" | "roomId" | "arrival" | "departure">): Booking {
  return { propertyId: PROPERTY.id, unitId: 1, status: "confirmed", numAdult: 2, modifiedTime: nowStamp(), ...b } as Booking;
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
    const conn = await api("/api/admin/connection", { token: tok.admin });
    fakeWired = conn.body?.baseUrl === FAKE_URL.href.replace(/\/$/, "");
  }

  // Beds24'dagi bronlar (real maydon nomlari bilan)
  fake.bookings = [
    book({ id: 9001, roomId: 5001, arrival: day(10), departure: day(12), price: 72, firstName: "Ali", lastName: "Valiyev",
      apiSource: "Booking.com", channel: "booking", apiReference: "BK-1001", bookingTime: "2026-09-20 10:00:00" }),
    book({ id: 9002, roomId: 5002, status: "new", arrival: day(20), departure: day(22), numAdult: 3, price: 80,
      firstName: "John", lastName: "Smith", channel: "direct" }),
    book({ id: 9003, roomId: 5001, status: "cancelled", arrival: day(30), departure: day(31), numAdult: 1, price: 36,
      firstName: "Bekor", apiSource: "Booking.com", channel: "booking", apiReference: "BK-1003" }),
    // Bog'lanmagan unit ("999") — PMS'ga tushmaydi, qo'lda hal qilinadi
    book({ id: 9004, roomId: 5003, arrival: day(5), departure: day(6), numAdult: 1, price: 30, firstName: "Sinov" }),
    // Beds24 panelida yopilgan xona
    book({ id: 9006, roomId: 5001, status: "black", arrival: day(50), departure: day(52), numAdult: 1,
      firstName: "Ta'mir", notes: "Konditsioner" }),
    // Qabulxona qo'lda kiritgan Booking.com broni bilan bir xil — dublikat bo'lmasligi kerak
    book({ id: 9007, roomId: 5002, arrival: day(60), departure: day(62), price: 90, firstName: "Qo'lda", lastName: "Kiritilgan",
      apiSource: "Booking.com", channel: "booking", apiReference: "BK-2000" }),
    // O'tib ketgan — `departureFrom` bilan kelmaydi
    book({ id: 9000, roomId: 5001, arrival: day(-5), departure: day(-3), numAdult: 1, price: 36, firstName: "Eski" }),
  ];
}, 30_000);

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
});

const ready = () => fakeWired;

// ============================================================
//  0. Muhit
// ============================================================

describe("Test muhiti", () => {
  it("BEDS24_BASE_URL sozlangan bo'lsa, server soxta Beds24'ga ulangan (testlar jim o'tkazib yuborilmasin)", () => {
    if (!process.env.BEDS24_BASE_URL) return;   // sozlanmagan — README'dagi eslatma
    expect(fakeWired, "server BEDS24_BASE_URL ni ko'rmayapti — test.env ni serverga ham bering").toBe(true);
  });
});

// ============================================================
//  1. Ruxsatlar
// ============================================================

describe("Ruxsatlar — avvalgidek: egasi va admin boshqaradi, menejer o'qiydi", () => {
  it("STAFF — Channel manager yopiq (403), MANAGER — o'qiydi, yoza olmaydi", async () => {
    if (!authOn) return;   // AUTH_REQUIRED=false — ruxsat tekshirilmaydi
    for (const path of ["/api/admin/connection", "/api/admin/status", "/api/admin/mapping", "/api/admin/sync-log", "/api/admin/fx"]) {
      expect((await api(path, { token: tok.staff })).status, `STAFF ${path}`).toBe(403);
      expect((await api(path, { token: tok.manager })).status, `MANAGER ${path}`).toBe(200);
    }
    for (const [method, path] of [
      ["POST", "/api/admin/connection"], ["PUT", "/api/admin/mapping"], ["POST", "/api/admin/mapping/auto-units"],
      ["POST", "/api/admin/maintenance/poll"], ["PUT", "/api/admin/fx"], ["POST", "/api/admin/fx/refresh"],
    ] as const) {
      const r = await api(path, { method, token: tok.manager, body: {} });
      expect(r.status, `MANAGER ${method} ${path}`).toBe(403);
    }
  });

  it("tokensiz — 401", async () => {
    if (!authOn) return;
    const r = await fetch(`${PMS}/api/admin/connection`, { headers: { Authorization: "Bearer x" } });
    expect(r.status).toBe(401);
  });

  it("ADMIN — ulanish holatini ko'radi, token hech qachon chiqmaydi", async () => {
    const r = await api("/api/admin/connection", { token: tok.admin });
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(false);
    expect(r.body.encryptionKeySet).toBe(true);
    expect(r.text.toLowerCase()).not.toContain("refreshtoken");
  });
});

// ============================================================
//  2. Ulanish
// ============================================================

describe("Ulanish — invite code, shifrlangan token", () => {
  it("noto'g'ri invite code — 400, ulanmaydi", async () => {
    if (!ready()) return;
    const r = await api("/api/admin/connection", { method: "POST", token: tok.admin, body: { inviteCode: "XATO-KOD" } });
    expect(r.status).toBe(400);
    expect((await api("/api/admin/connection", { token: tok.admin })).body.connected).toBe(false);
  });

  it("hisobda yo'q obyekt ID — 400", async () => {
    if (!ready()) return;
    const r = await api("/api/admin/connection", { method: "POST", token: tok.admin, body: { inviteCode: "INVITE-OK", propertyId: "999" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("777");
  });

  it("to'g'ri invite code — ulanadi, ping ishlaydi, token bazada shifrlangan", async () => {
    if (!ready()) return;
    const r = await api("/api/admin/connection", { method: "POST", token: tok.admin, body: { inviteCode: "INVITE-OK" } });
    expect(r.status).toBe(201);
    expect(r.body.connection.connected).toBe(true);
    expect(r.body.connection.propertyId).toBe("777");
    expect(r.body.ping.ok).toBe(true);
    expect(r.body.ping.scopes).toContain("all:bookings");
    expect(r.text).not.toContain("secret");

    const conn = await prisma.channelConnection.findFirstOrThrow({ where: { isActive: true } });
    expect(conn.refreshToken).not.toContain("ref-");
    expect(conn.accessToken).not.toContain("acc-");
  });

  it("refresh token almashsa yangisi saqlanadi — ulanish uzilmaydi", async () => {
    if (!ready()) return;
    const before = await prisma.channelConnection.findFirstOrThrow({ where: { isActive: true } });
    await prisma.channelConnection.update({ where: { id: before.id }, data: { accessTokenExpiresAt: new Date(0) } });

    const p1 = await api("/api/admin/connection/ping", { method: "POST", token: tok.admin });
    expect(p1.body.ok).toBe(true);
    const after = await prisma.channelConnection.findFirstOrThrow({ where: { isActive: true } });
    expect(after.refreshToken).not.toBe(before.refreshToken);

    // Yana bir marta — eski refresh token o'lgan, yangisi ishlashi kerak
    await prisma.channelConnection.update({ where: { id: after.id }, data: { accessTokenExpiresAt: new Date(0) } });
    expect((await api("/api/admin/connection/ping", { method: "POST", token: tok.admin })).body.ok).toBe(true);
  });

  it("bog'lanish yo'q — polling kutadi, hech narsa import qilinmaydi", async () => {
    if (!ready()) return;
    const r = await api("/api/admin/maintenance/poll", { method: "POST", token: tok.admin });
    expect(r.status).toBe(200);
    expect(r.body.fetched).toBe(0);
    expect(await byExternal(9001)).toBeNull();
  });
});

// ============================================================
//  3. Bog'lash va import (Beds24 -> PMS)
// ============================================================

let manualId = "";

describe("Import — Beds24 bronlari PMS'ga", () => {
  it("qo'lda kiritilgan Booking.com broni Beds24'ga YUBORILMAYDI (u yerda allaqachon bor)", async () => {
    if (!ready()) return;
    const r = await api("/api/reservations", {
      method: "POST", token: tok.admin,
      body: {
        roomId: "102", guestName: "Qo'lda Kiritilgan", phone: "+998900000060", checkIn: day(60), checkOut: day(62),
        adults: 2, pricePerNight: 1_000_000, source: "booking_com",
      },
    });
    expect(r.status).toBe(201);
    manualId = r.body.id;
    // Bog'lanmagan xona hali — NOT_APPLICABLE; OTA manbasi — baribir yuborilmaydi
    await waitFor(async () => {
      const x = await prisma.reservation.findUnique({ where: { id: manualId } });
      return x && x.syncStatus !== "PENDING" && x.syncStatus !== "SYNCING";
    }, "qo'lda bron holati");
    expect(fake.posts.filter((p) => p.path === "/bookings")).toHaveLength(0);
  });

  it("unit'lar nom bo'yicha bog'lanadi (101, 102), \"999\" bog'lanmaydi", async () => {
    if (!ready()) return;
    const r = await api("/api/admin/mapping/auto-units", { method: "POST", token: tok.admin });
    expect(r.status).toBe(200);
    expect(r.body.mapped.map((m: any) => m.roomId).sort()).toEqual(["101", "102"]);
    expect(r.body.skipped.map((s: any) => s.unitName)).toEqual(["999"]);
  });

  it("bog'langach to'liq import: OTA broni dollarda, bron kursi bilan, OTA raqami bilan", async () => {
    if (!ready()) return;
    const r = await waitFor(() => byExternal(9001), "9001 import");
    expect(r.roomId).toBe("101");
    expect(r.origin).toBe("CHANNEL");
    expect(r.source).toBe("BOOKING_COM");
    expect(r.currency).toBe("USD");
    expect(Number(r.exchangeRate)).toBe(RATE);
    expect(Number(r.pricePerNight)).toBe(36);
    expect(r.externalReference).toBe("BK-1001");
    expect(r.syncStatus).toBe("SYNCED");
  });

  it("ulanishdan oldingi qabulxona broni (xonadagi mehmon) bog'langach DARHOL Beds24'ga — catch-up kutilmaydi", async () => {
    if (!ready()) return;
    const r = await waitFor(async () => {
      const x = await prisma.reservation.findFirst({ where: { roomId: "101", status: "CHECKED_IN", origin: "PMS" } });
      return x?.syncStatus === "SYNCED" && x.externalReservationId ? x : null;
    }, "101 CHECKED_IN yuborildi");
    const b = fake.bookings.find((x) => String(x.id) === r.externalReservationId)!;
    expect(b.roomId).toBe(5001);
    expect(b.arrival).toBe(day(-2));
    // Bog'lanmagan xonadagi bron — jim NOT_APPLICABLE (xato emas)
    await waitFor(async () => {
      const x = await prisma.reservation.findFirst({ where: { roomId: "103", status: "CONFIRMED" } });
      return x?.syncStatus === "NOT_APPLICABLE";
    }, "103 NOT_APPLICABLE");
  });

  it("Beds24 panelidagi to'g'ridan-to'g'ri bron: `new` -> CONFIRMED, PMS boshqaradi (OTA emas)", async () => {
    if (!ready()) return;
    const r = await waitFor(() => byExternal(9002), "9002 import");
    expect(r.roomId).toBe("102");
    expect(r.status).toBe("CONFIRMED");
    expect(r.source).toBe("DIRECT");
    const s = await api(`/api/reservations/${r.id}`, { token: tok.admin });
    expect(s.body.channelOwned).toBe(false);
  });

  it("bekor qilingan, o'tgan va bog'lanmagan bronlar PMS'ga tushmaydi", async () => {
    if (!ready()) return;
    await waitFor(() => byExternal(9001), "import tugashi");
    for (const id of [9003, 9000, 9004]) expect(await byExternal(id), String(id)).toBeNull();
  });

  it("qo'lda kiritilgan OTA broni DUBLIKAT bo'lmaydi — Beds24 broniga bog'lanadi", async () => {
    if (!ready()) return;
    const linked = await waitFor(() => byExternal(9007), "9007 bog'lanishi");
    expect(linked.id).toBe(manualId);
    expect(linked.origin).toBe("CHANNEL");
    expect(linked.externalReference).toBe("BK-2000");
    // PMS narxi (so'm) saqlanadi — Beds24 dollar narxi ustiga yozilmaydi
    expect(linked.currency).toBe("UZS");
    expect(Number(linked.pricePerNight)).toBe(1_000_000);
    const count = await prisma.reservation.count({ where: { roomId: "102", checkIn: new Date(day(60)) } });
    expect(count).toBe(1);
  });

  it("Beds24'da yopilgan xona (`black`) PMS'da yopiladi va PMS uni ocholmaydi", async () => {
    if (!ready()) return;
    const block = await waitFor(
      () => prisma.channelBlock.findFirst({ where: { externalId: "9006", origin: "CHANNEL", isActive: true } }),
      "black -> ChannelBlock"
    );
    expect(block.roomId).toBe("101");
    const days = await prisma.roomDayStatus.findMany({ where: { roomId: "101", isBlocked: true, date: { gte: new Date(day(50)), lt: new Date(day(52)) } } });
    expect(days).toHaveLength(2);
    expect(days[0].blockReason).toContain("Beds24:");

    const r = await api("/api/rooms/blocks", { method: "DELETE", token: tok.admin, body: { roomIds: ["101"], from: day(50), to: day(51) } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("CHANNEL_OWNED");
  });

  it("bog'lanmagan unit broni jurnalda qo'lda hal qilish uchun turadi", async () => {
    if (!ready()) return;
    const log = await waitFor(
      () => prisma.syncLog.findFirst({ where: { action: "poll_needs_action", errorMessage: { contains: "5003" } } }),
      "needs action jurnali"
    );
    expect(log.errorMessage).toContain("bog'lanmagan");
  });
});

// ============================================================
//  4. PMS -> Beds24
// ============================================================

describe("PMS -> Beds24 — bron yuborish", () => {
  let pmsId = "";

  it("qabulxona broni Beds24'ga yuboriladi: unit, dollarda narx, checkAvailability", async () => {
    if (!ready()) return;
    const r = await api("/api/reservations", {
      method: "POST", token: tok.admin,
      body: { roomId: "101", guestName: "Sardor Karimov", phone: "+998901112233", checkIn: day(20), checkOut: day(22), adults: 2, pricePerNight: 450_000 },
    });
    expect(r.status).toBe(201);
    pmsId = r.body.id;

    const synced = await waitFor(async () => {
      const x = await prisma.reservation.findUnique({ where: { id: pmsId } });
      return x?.syncStatus === "SYNCED" && x.externalReservationId ? x : null;
    }, "PMS broni SYNCED");
    const created = fake.bookings.find((b) => String(b.id) === synced.externalReservationId)!;
    expect(created.roomId).toBe(5001);
    expect(created.unitId).toBe(1);
    expect(created.referer).toBe("PMS");
    expect(created.price).toBe(Math.round((900_000 / RATE) * 100) / 100);   // 2 kecha x 450 000 so'm
    const post = fake.posts.filter((p) => p.path === "/bookings").map((p) => p.body[0]).find((b) => b.firstName === "Sardor");
    expect(post.actions).toEqual({ checkAvailability: true });
  });

  it("Beds24'da joy yo'q — REJECTED, xabar aniq, catch-up QAYTA YUBORMAYDI", async () => {
    if (!ready()) return;
    // Beds24'ga PMS bilmagan bron tushdi (polling hali olib kelmagan)
    fake.bookings.push(book({ id: 9010, roomId: 5001, arrival: day(30), departure: day(32), price: 70, firstName: "Yashirin",
      apiSource: "Booking.com", channel: "booking", apiReference: "BK-3000" }));

    const r = await api("/api/reservations", {
      method: "POST", token: tok.admin,
      body: { roomId: "101", guestName: "Rad Etiladi", phone: "+998901112244", checkIn: day(30), checkOut: day(32), adults: 1, pricePerNight: 450_000 },
    });
    expect(r.status).toBe(201);   // PMS'da bron yaratiladi — Beds24 kutilmaydi
    const rejected = await waitFor(async () => {
      const x = await prisma.reservation.findUnique({ where: { id: r.body.id } });
      return x?.syncStatus === "REJECTED" ? x : null;
    }, "REJECTED");
    expect(rejected.syncError).toContain("joy yo'q");

    const posts = fake.posts.length;
    const c = await api("/api/admin/maintenance/catch-up", { method: "POST", token: tok.admin });
    expect(c.status).toBe(200);
    expect(fake.posts.length, "rad etilgan bron qayta POST qilinmasin").toBe(posts);

    // Polling Beds24 bronini olib keladi: 101 band — mehmon Shaxmatkadan
    // yo'qolmaydi, shu turdagi Beds24'ga BOG'LANMAGAN xonaga joylanadi
    // (Beds24'da bron Room 1 da qoladi — band 101 sotilmaydi), xodim ogohlantiriladi
    await api("/api/admin/maintenance/poll", { method: "POST", token: tok.admin });
    const ota = (await byExternal(9010))!;
    expect(ota).toBeTruthy();
    expect(ota.roomId).toBe("202");
    const warn = await prisma.syncLog.findFirst({ where: { action: "reservation_relocated", reservationId: ota.id } });
    expect(warn?.errorMessage).toContain("101");

    // Xodim bronni bekor qiladi — Beds24'ga yangi bron yaratilmaydi
    await api(`/api/reservations/${r.body.id}/cancel`, { method: "POST", token: tok.admin });
    await waitFor(async () => {
      const x = await prisma.reservation.findUnique({ where: { id: r.body.id } });
      return x?.syncStatus === "NOT_APPLICABLE" ? x : null;
    }, "bekor qilingan rad etilgan bron");
    expect(fake.posts.length).toBe(posts);
  });

  it("sana o'zgarsa Beds24'da ham o'zgaradi (to'liq rejim)", async () => {
    if (!ready()) return;
    const r = await api(`/api/reservations/${pmsId}/change-dates`, { method: "POST", token: tok.admin, body: { checkIn: day(20), checkOut: day(23) } });
    expect(r.status).toBe(200);
    const res = await prisma.reservation.findUniqueOrThrow({ where: { id: pmsId } });
    await waitFor(async () => fake.bookings.find((b) => String(b.id) === res.externalReservationId)?.departure === day(23), "Beds24 sanasi");
  });
});

// ============================================================
//  5. OTA qulfi, check-in, webhook
// ============================================================

describe("OTA broni (Q9) — sana, narx, bekor qilish OTA'da", () => {
  it("bekor qilish, sana, narx, boshqa turga ko'chirish — 409 CHANNEL_OWNED", async () => {
    if (!ready()) return;
    const r = (await byExternal(9001))!;
    const cancel = await api(`/api/reservations/${r.id}/cancel`, { method: "POST", token: tok.admin });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe("CHANNEL_OWNED");
    expect((await api(`/api/reservations/${r.id}/change-dates`, { method: "POST", token: tok.admin, body: { checkIn: day(10), checkOut: day(13) } })).status).toBe(409);
    expect((await api(`/api/reservations/${r.id}`, { method: "PATCH", token: tok.admin, body: { pricePerNight: 10 } })).status).toBe(409);
    expect((await api(`/api/reservations/${r.id}/change-room`, { method: "POST", token: tok.admin, body: { roomId: "102" } })).body.code).toBe("CHANNEL_OWNED");
  });

  it("Beds24 bilan bog'lanmagan xonaga ko'chirib bo'lmaydi (u yerda bron eski xonada qolardi)", async () => {
    if (!ready()) return;
    const r = (await byExternal(9001))!;
    const move = await api(`/api/reservations/${r.id}/change-room`, { method: "POST", token: tok.admin, body: { roomId: "202" } });
    expect(move.status).toBe(400);
    expect(move.body.error).toContain("bog'lanmagan");
  });

  it("izoh va nonushta o'zgartirilsa bo'ladi; Beds24'ga faqat xona va belgi ketadi", async () => {
    if (!ready()) return;
    const r = (await byExternal(9001))!;
    const p = await api(`/api/reservations/${r.id}`, { method: "PATCH", token: tok.admin, body: { notes: "Kech keladi" } });
    expect(p.status).toBe(200);
    await waitFor(async () => (await prisma.reservation.findUnique({ where: { id: r.id } }))?.syncStatus === "SYNCED", "OTA bron SYNCED");
    const last = fake.posts.filter((x) => x.path === "/bookings").map((x) => x.body[0]).filter((b) => b.id === 9001).pop();
    expect(last).toBeTruthy();
    expect(last).not.toHaveProperty("price");
    expect(last).not.toHaveProperty("arrival");
    expect(last).not.toHaveProperty("status");
  });
});

describe("Webhook (TZ 10-band)", () => {
  const hook = (payload: unknown) => api(`/api/webhooks/beds24/${WEBHOOK_TOKEN}`, { method: "POST", body: payload });

  it("Booking.com'da sana o'zgardi — PMS'ga keladi; takror webhook e'tiborsiz", async () => {
    if (!ready() || WEBHOOK_TOKEN.length < 16) return;
    const b = fake.bookings.find((x) => x.id === 9001)!;
    b.departure = day(13);
    b.price = 108;
    b.modifiedTime = nowStamp();
    const payload = { timeStamp: new Date().toISOString(), booking: { ...b }, invoiceItems: [], retries: 0 };

    const r1 = await hook(payload);
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("accepted");
    await waitFor(async () => (await byExternal(9001))?.checkOut.toISOString().slice(0, 10) === day(13), "webhook sana");
    const r = (await byExternal(9001))!;
    expect(Number(r.pricePerNight)).toBe(36);   // $108 / 3 kecha

    // Qayta yuborish (retries oshgan) — bir xil mazmun
    const r2 = await hook({ ...payload, timeStamp: new Date().toISOString(), retries: 1 });
    expect(r2.body.status).toBe("duplicate");
  });

  it("OTA'da mehmon ismi va telefoni o'zgardi — PMS'da yangilanadi, yangi bron yaratilmaydi (TZ 7)", async () => {
    if (!ready() || WEBHOOK_TOKEN.length < 16) return;
    const b = fake.bookings.find((x) => x.id === 9001)!;
    b.firstName = "Alisher";
    b.lastName = ".";                          // bir so'zli ism: nuqta ismga qo'shilmasin
    (b as any).phone = "+998901234599";
    b.modifiedTime = nowStamp();
    await hook({ timeStamp: new Date().toISOString(), booking: { ...b } });

    const guest = await waitFor(async () => {
      const r = await prisma.reservation.findFirst({ where: { externalReservationId: "9001" }, include: { guest: true } });
      return r?.guest.phone === "+998901234599" ? r.guest : null;
    }, "webhook mehmon");
    expect(guest.fullName).toBe("Alisher");
    expect(await prisma.reservation.count({ where: { externalReservationId: "9001" } })).toBe(1);
  });

  it("PMS boshqaradigan bron: Beds24'dagi ism xodim kiritganini bosmaydi, bo'sh maydon to'ldiriladi", async () => {
    if (!ready() || WEBHOOK_TOKEN.length < 16) return;
    const b = fake.bookings.find((x) => x.id === 9002)!;   // channel "direct" — PMS boshqaradi
    b.lastName = "Smithson";
    (b as any).phone = "+998901234598";
    b.modifiedTime = nowStamp();
    await hook({ timeStamp: new Date().toISOString(), booking: { ...b } });

    const guest = await waitFor(async () => {
      const r = await prisma.reservation.findFirst({ where: { externalReservationId: "9002" }, include: { guest: true } });
      return r?.guest.phone === "+998901234598" ? r.guest : null;
    }, "webhook bo'sh telefon");
    expect(guest.fullName).toBe("John Smith");
  });

  it("yangi OTA broni webhook bilan darhol Shaxmatkada", async () => {
    if (!ready() || WEBHOOK_TOKEN.length < 16) return;
    const b = book({ id: 9011, roomId: 5002, arrival: day(40), departure: day(41), price: 45, firstName: "Yangi",
      apiSource: "Booking.com", channel: "booking", apiReference: "BK-4000" });
    fake.bookings.push(b);
    expect((await hook({ timeStamp: new Date().toISOString(), booking: b })).status).toBe(200);
    const r = await waitFor(() => byExternal(9011), "webhook yangi bron");
    expect(r.roomId).toBe("102");
    expect(r.origin).toBe("CHANNEL");
  });

  it("OTA'da bekor qilindi — PMS'da CANCELLED, xona bo'shaydi", async () => {
    if (!ready() || WEBHOOK_TOKEN.length < 16) return;
    const b = fake.bookings.find((x) => x.id === 9011)!;
    b.status = "cancelled";
    b.modifiedTime = nowStamp();
    await hook({ timeStamp: new Date().toISOString(), booking: b });
    await waitFor(async () => (await byExternal(9011))?.status === "CANCELLED", "webhook bekor qilish");
  });
});

// ============================================================
//  6. Dollar bron (Q15)
// ============================================================

describe("Dollar bron — tagida so'm, so'mda to'lov bron kursi bilan", () => {
  it("bron javobida $ va so'm (bron kursi bilan) — qabulxonaga ham ko'rinadi", async () => {
    if (!ready()) return;
    const r = (await byExternal(9001))!;
    const s = await api(`/api/reservations/${r.id}`, { token: authOn ? tok.staff : tok.admin });
    expect(s.status).toBe(200);
    expect(s.body.currency).toBe("USD");
    expect(s.body.exchangeRate).toBe(RATE);
    expect(s.body.totalPrice).toBe(108);                 // $36 x 3 kecha
    expect(s.body.base.total).toBe(108 * RATE);          // 1 350 000 so'm
    expect(s.body.channelOwned).toBe(true);
  });

  it("so'mda to'lov: bron kursi bilan dollarga, asl so'm saqlanadi; qarz so'mda to'g'ri", async () => {
    if (!ready()) return;
    const r = (await byExternal(9001))!;
    const p = await api(`/api/reservations/${r.id}/payments`, {
      method: "POST", token: tok.admin, body: { amount: 450_000, method: "Naqd", currency: "UZS" },
    });
    expect(p.status).toBe(201);
    const pay = p.body.payments[p.body.payments.length - 1];
    expect(pay.amount).toBe(36);
    expect(pay.originalAmount).toBe(450_000);
    expect(pay.originalCurrency).toBe("UZS");
    expect(pay.amountBase).toBe(450_000);
    expect(p.body.remainingAmount).toBe(72);
    expect(p.body.base.remaining).toBe(72 * RATE);

    // Qarzdan oshsa — xabar ikkala valyutada
    const over = await api(`/api/reservations/${r.id}/payments`, {
      method: "POST", token: tok.admin, body: { amount: 2_000_000, method: "Naqd", currency: "UZS" },
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain("$72.00");
    expect(over.body.error).toContain("900 000 so'm");
  });

  it("hisobot so'mda: dollar bron bron kursi bilan, kassa — tushgan so'm", async () => {
    if (!ready()) return;
    const rep = await api(`/api/admin/report?from=${day(0)}&to=${day(15)}`, { token: tok.founder });
    expect(rep.status).toBe(200);
    expect(rep.body.channel.connected).toBe(true);
    expect(rep.body.channel.usdBookings).toBeGreaterThanOrEqual(1);
    expect(rep.body.channel.revenue).toBeGreaterThanOrEqual(108 * RATE);
  });
});

// ============================================================
//  7. Yopish, narx, drift, kurs
// ============================================================

describe("Xona yopish -> Beds24 `black`", () => {
  it("PMS'da yopilgan xona Beds24'da black bron bo'ladi, ochilganda bekor qilinadi", async () => {
    if (!ready()) return;
    const b = await api("/api/rooms/blocks", { method: "POST", token: tok.admin, body: { roomIds: ["102"], from: day(70), to: day(71), reason: "Bo'yoq" } });
    expect(b.status).toBe(201);
    const black = await waitFor(
      async () => fake.bookings.find((x) => x.status === "black" && x.roomId === 5002 && x.arrival === day(70)),
      "Beds24 black"
    );
    expect(black.departure).toBe(day(72));
    expect(black.referer).toBe("PMS");

    await api("/api/rooms/blocks", { method: "DELETE", token: tok.admin, body: { roomIds: ["102"], from: day(70), to: day(71) } });
    await waitFor(async () => fake.bookings.find((x) => x.id === black.id)?.status === "cancelled", "black bekor");
  });
});

describe("Narx — PMS so'mda, Beds24'ga dollarda", () => {
  it("admin narx qo'ysa Beds24 kalendariga $ bo'lib ketadi, holat 'synced'", async () => {
    if (!ready()) return;
    const r = await api("/api/rate-plans", { method: "PUT", token: tok.admin, body: { from: day(90), to: day(91), prices: { comfort3: 500_000 } } });
    expect(r.status).toBe(200);
    await waitFor(async () => fake.calendar.get(5001)?.get(day(91))?.price1 === 40, "Beds24 narxi $40");
    const plans = await api(`/api/rate-plans?from=${day(90)}&to=${day(91)}`, { token: tok.admin });
    const row = plans.body.find((p: any) => p.roomTypeId === "comfort3");
    expect(row.syncStatus).toBe("synced");
    expect(row.channelPrice).toBe(40);
  });

  it("bog'lanmagan tarif narxi yuborilmaydi va xato ham yozilmaydi", async () => {
    if (!ready()) return;
    const failedBefore = await prisma.syncLog.count({ where: { action: "push_rates", status: "FAILED" } });
    await api("/api/rate-plans", { method: "PUT", token: tok.admin, body: { from: day(90), to: day(90), prices: { deluxe4: 700_000 } } });
    await new Promise((r) => setTimeout(r, 4500));   // debounce + navbat
    expect(await prisma.syncLog.count({ where: { action: "push_rates", status: "FAILED" } })).toBe(failedBefore);
  });

  it("tur darajasidagi bog'lanish: Beds24 panelidagi narx PMS'ga tortiladi (Beds24 ustuvor)", async () => {
    if (!ready()) return;
    const m = await api("/api/admin/mapping", {
      method: "PUT", token: tok.admin, body: { externalRoomTypeId: "5003", externalName: "Sinov", roomTypeId: "famlux201" },
    });
    expect(m.status).toBe(200);
    const cal = fake.calendar.get(5003) ?? new Map();
    for (let n = 0; n <= 3; n++) cal.set(day(n), { numAvail: 1, price1: 80 });
    fake.calendar.set(5003, cal);

    // 0-1 kun: avval Beds24'ga yuborilgan ($64); 2-3 kun: admin o'zgartirgan, hali yuborilmagan
    await prisma.ratePlan.updateMany({
      where: { roomTypeId: "famlux201", date: { gte: new Date(day(0)), lte: new Date(day(1)) } },
      data: { syncedAt: new Date(), channelPrice: 64 },
    });
    await prisma.ratePlan.updateMany({
      where: { roomTypeId: "famlux201", date: { gte: new Date(day(2)), lte: new Date(day(3)) } },
      data: { syncedAt: null },
    });

    const r = await api("/api/admin/maintenance/pull-rates", { method: "POST", token: tok.admin });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(2);
    expect(r.body.keptPending).toBe(2);   // yuborilmagan PMS narxi ustiga yozilmaydi
    const plan = await prisma.ratePlan.findUniqueOrThrow({ where: { roomTypeId_date: { roomTypeId: "famlux201", date: new Date(day(1)) } } });
    expect(Number(plan.price)).toBe(80 * RATE);
    expect(plan.source).toBe("beds24");
    const kept = await prisma.ratePlan.findUniqueOrThrow({ where: { roomTypeId_date: { roomTypeId: "famlux201", date: new Date(day(2)) } } });
    expect(Number(kept.price)).toBe(800_000);
  });

  it("farq tekshiruvi faqat qayd etadi", async () => {
    if (!ready()) return;
    const r = await api("/api/admin/maintenance/drift", { method: "POST", token: tok.admin });
    expect(r.status).toBe(200);
    expect(r.body.checkedDays).toBeGreaterThan(0);
  });
});

describe("Kurs (Markaziy bank / qo'lda)", () => {
  it("qo'lda kurs va Markaziy bankdan qayta olish", async () => {
    if (!ready()) return;
    const m = await api("/api/admin/fx", { method: "PUT", token: tok.admin, body: { rate: 12600 } });
    expect(m.status).toBe(200);
    expect(m.body.fx.source).toBe("manual");
    const r = await api("/api/admin/fx/refresh", { method: "POST", token: tok.admin });
    expect(r.status).toBe(200);
    expect(r.body.fx.rate).toBe(RATE);
    expect(r.body.fx.source).toBe("cbu");
    // Kechagi dollar bron kursi o'zgarmaydi (bron kelgan kun kursi qotadi)
    expect(Number((await byExternal(9001))!.exchangeRate)).toBe(RATE);
  });
});

describe("Holat va uzish", () => {
  it("holat sahifasi: bog'lanish, bronlar, jurnal", async () => {
    if (!ready()) return;
    const s = await api("/api/admin/status", { token: tok.admin });
    expect(s.status).toBe(200);
    expect(s.body.connection.connected).toBe(true);
    expect(s.body.mapping.unitLevel).toBe(2);
    expect(s.body.reservations.fromChannel).toBeGreaterThanOrEqual(2);
    expect(s.body.reservations.rejected).toBe(0);   // rad etilgan bron bekor qilingan
  });

  it("uzilganda tokenlar o'chadi, sinxron vazifalar jim o'tadi", async () => {
    if (!ready()) return;
    const d = await api("/api/admin/connection", { method: "DELETE", token: tok.admin });
    expect(d.status).toBe(200);
    const conn = await prisma.channelConnection.findFirst({ where: { isActive: true } });
    expect(conn).toBeNull();
    const posts = fake.posts.length;
    const poll = await api("/api/admin/maintenance/poll", { method: "POST", token: tok.admin });
    expect(poll.body.fetched).toBe(0);
    expect(fake.posts.length).toBe(posts);
  });
});
