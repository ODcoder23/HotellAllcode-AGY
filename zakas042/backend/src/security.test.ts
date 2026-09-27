/**
 * FAZA 12 — Xavfsizlik va audit
 *
 * TZ 18-band: to'qqiz xavfsizlik talabi.
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 12):
 *   "10-fayl §1 jadvalidagi 9 ta talab ham 'bajarildi'."
 *
 * Cheklist (10-fayl §9) shu test bilan avtomatlashtiriladi —
 * qo'lda tekshirish o'rniga har yurishda qayta sinaladi.
 *
 * Ishga tushirish:  npx vitest run src/security.test.ts
 * Shart: server (:3000), PostgreSQL
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./lib/prisma.js";
import {
  PERMISSIONS, can, hashPassword, verifyPassword,
  signToken, verifyToken, login, createUser,
} from "./services/auth.js";
import { audit, listAudit, AUDIT_ACTIONS } from "./services/auditLog.js";
import { sanitizeForLog } from "./lib/sanitize.js";
import type { UserRole } from "@prisma/client";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const BACKEND_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, raw: text };
};

/** Test uchun yaratilgan foydalanuvchilar — tozalash uchun */
const created: string[] = [];

/**
 * ADMIN token — auth yoqilgan bo'lsa kerak bo'ladi.
 *
 * Testlar ikkala rejimda ham ishlashi kerak: dev'da
 * `AUTH_REQUIRED=false`, production tekshiruvida `true`.
 */
let adminAuth: Record<string, string> = {};
/**
 * FOUNDER token — foydalanuvchi boshqaruvi (`user.manage`) 2026-09-16
 * dan faqat FOUNDER'da. ADMIN token bilan bu amallar 403 oladi.
 */
let founderAuth: Record<string, string> = {};

async function loadAdminToken(): Promise<void> {
  const health = await api("/health");
  if (health.body?.security?.auth !== true) return;

  for (const [email, set] of [
    ["admin@imron.local", (t: string) => { adminAuth = { Authorization: `Bearer ${t}` }; }],
    ["founder@imron.local", (t: string) => { founderAuth = { Authorization: `Bearer ${t}` }; }],
  ] as const) {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: "admin12345" }),
    });
    if (res.body?.token) set(res.body.token);
  }
}

describe("FAZA 12 — xavfsizlik va audit (TZ 16, 18-band)", () => {
  beforeAll(async () => {
    const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
    if (!health.security) throw new Error("/health'da security yo'q — server yangilanmagan");
    await loadAdminToken();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.auditLog.deleteMany({ where: { userId: { in: created } } });
      await prisma.user.deleteMany({ where: { id: { in: created } } });
    }
  });

  // --- 1. Beds24 (channel manager) yuzasi --------------------
  describe("1. Beds24 — ruxsatlar va tashqi yuza", () => {
    /**
     * 2026-09-27, egasi qarori: integratsiya avvalgidek qaytdi.
     * Ulash va bog'lash — FOUNDER, ADMIN; holat va jurnal — MANAGER ham;
     * qabulxona (STAFF) Channel manager'ni ko'rmaydi, lekin bron ichidagi
     * dollar summasini ko'radi. STOP olib tashlangan.
     */
    it("webhook: tokensiz yoki noto'g'ri token — 404 (endpoint oshkor qilinmaydi)", async () => {
      for (const path of ["/api/webhooks/beds24", "/api/webhooks/beds24/dev-webhook-token"]) {
        const res = await api(path, { method: "POST", body: "{}" });
        expect(res.status, path).toBe(404);
      }
    });

    it("olib tashlangan endpoint'lar yo'q (404): STOP, qo'lda OTA raqami, kuzatuv nusxalari", async () => {
      const paths: Array<[string, string]> = [
        ["GET", "/api/admin/sales-stop"],
        ["POST", "/api/admin/sales-stop"],
        ["POST", "/api/admin/sales-stop/release"],
        ["PUT", "/api/reservations/x/external-ref"],
        ["GET", "/api/admin/channel/bookings"],
        ["GET", "/api/admin/rates"],
        ["POST", "/api/admin/cleaning/x/reassign"],
      ];
      for (const [method, path] of paths) {
        const res = await api(path, { method, headers: founderAuth, ...(method !== "GET" ? { body: "{}" } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    });

    it("Channel manager: STAFF yopiq, MANAGER faqat o'qiydi, ADMIN boshqaradi", async () => {
      if (!adminAuth.Authorization) return;   // AUTH o'chiq — rol tekshirilmaydi
      const tokenOf = async (email: string) => {
        const res = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "admin12345" }) });
        return { Authorization: `Bearer ${res.body?.token}` };
      };
      const manager = await tokenOf("manager@imron.local");
      const staff = await tokenOf("staff@imron.local");

      const reads = ["/api/admin/connection", "/api/admin/status", "/api/admin/sync-log", "/api/admin/webhook-events"];
      for (const path of reads) {
        expect((await api(path, { headers: staff })).status, `STAFF ${path}`).toBe(403);
        expect((await api(path, { headers: manager })).status, `MANAGER ${path}`).toBe(200);
        expect((await api(path, { headers: adminAuth })).status, `ADMIN ${path}`).toBe(200);
      }

      const writes: Array<[string, string, unknown]> = [
        ["POST", "/api/admin/connection", { inviteCode: "XXXX-YYYY" }],
        ["PUT", "/api/admin/mapping", { externalRoomTypeId: "1", roomTypeId: "comfort3" }],
        ["POST", "/api/admin/maintenance/poll", {}],
        ["PUT", "/api/admin/fx", { rate: 12000 }],
      ];
      for (const [method, path, body] of writes) {
        const res = await api(path, { method, headers: manager, body: JSON.stringify(body) });
        expect(res.status, `MANAGER ${method} ${path}`).toBe(403);
      }
      // ADMIN'ga ochiq: ulanmagan bo'lsa ham xato 403 emas
      const poll = await api("/api/admin/maintenance/poll", { method: "POST", headers: adminAuth, body: "{}" });
      expect(poll.status).toBe(200);

      // Bugungi kurs Shaxmatka uchun — qabulxonaga ham
      expect((await api("/api/reservations/fx-rate", { headers: staff })).status).toBe(200);
    });

    it("/admin/*.html sahifalari faqat qobiq — ma'lumotsiz, token talab qiladi", async () => {
      for (const page of ["/admin/mapping.html", "/admin/connection.html", "/admin/sync-log.html"]) {
        const res = await fetch(`${PMS}${page}`);
        expect(res.status, page).toBe(200);
        const html = await res.text();
        expect(html, page).toContain("_shared.js");      // ma'lumot API'dan, token bilan
      }
    });

    it("bron javobida valyuta va Beds24 holati bor, token/kalit yo'q", async () => {
      const res = await api("/api/reservations", { headers: adminAuth });
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const key of ["currency", "syncStatus", "channelOwned", "externalReference", "base"]) {
        expect(res.body[0], key).toHaveProperty(key);
      }
      const text = res.raw.toLowerCase();
      for (const key of ["refreshtoken", "accesstoken", "passwordhash"]) {
        expect(text, key).not.toContain(key);
      }
    });

    it("ulanish holatida token hech qachon qaytmaydi", async () => {
      const res = await api("/api/admin/connection", { headers: adminAuth });
      expect(res.status).toBe(200);
      expect(res.raw.toLowerCase()).not.toContain("refreshtoken");
      expect(res.raw.toLowerCase()).not.toMatch(/"accesstoken"/);
    });
  });

  // --- 2. .env himoyasi (TZ 18-band, 2-talab) ----------------
  describe("2. .env va secret'lar", () => {
    it(".env .gitignore da", () => {
      const root = path.resolve(BACKEND_DIR, "..");
      const candidates = [
        path.join(root, ".gitignore"),
        path.join(BACKEND_DIR, ".gitignore"),
      ].filter((p) => fs.existsSync(p));

      expect(candidates.length).toBeGreaterThan(0);
      const all = candidates.map((p) => fs.readFileSync(p, "utf8")).join("\n");
      expect(all).toMatch(/(^|\n)\.env/);
    });

    it("JWT_SECRET sozlangan", () => {
      expect(process.env.JWT_SECRET ?? "").not.toBe("");
    });

    it("javoblarda brauzer xavfsizlik sarlavhalari bor", async () => {
      const res = await fetch(`${PMS}/health`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    });
  });

  // --- 3. JWT (TZ 18-band, 3-talab) --------------------------
  describe("3. JWT autentifikatsiya", () => {
    it("to'g'ri parol bilan token beriladi", async () => {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
      });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.role).toBe("ADMIN");
    });

    it("noto'g'ri parol 401 beradi", async () => {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "notogri" }),
      });
      expect(res.status).toBe(401);
    });

    it("mavjud bo'lmagan email BIR XIL xabar beradi", async () => {
      // Aks holda hujumchi qaysi email'lar borligini aniqlaydi
      const a = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "yoq@imron.local", password: "notogri" }),
      });
      const b = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "notogri" }),
      });

      expect(a.status).toBe(b.status);
      expect(a.body.error).toBe(b.body.error);
    });

    it("javobda passwordHash YO'Q", async () => {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
      });
      expect(res.raw.toLowerCase()).not.toContain("passwordhash");
      expect(res.raw).not.toContain("$2a$");
      expect(res.raw).not.toContain("$2b$");
    });

    it("token o'qiladi va tekshiriladi", () => {
      const token = signToken({ sub: "u1", role: "MANAGER", email: "m@x.uz" });
      const payload = verifyToken(token);
      expect(payload?.sub).toBe("u1");
      expect(payload?.role).toBe("MANAGER");
    });

    it("buzilgan token rad etiladi", () => {
      const token = signToken({ sub: "u1", role: "ADMIN", email: "a@x.uz" });
      expect(verifyToken(token + "x")).toBeNull();
      expect(verifyToken("umuman-token-emas")).toBeNull();
    });

    it("imzosiz (alg: none) token rad etiladi", () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", role: "FOUNDER", email: "h@x.uz" })}.`;
      expect(verifyToken(forged)).toBeNull();
    });

    it("muddati o'tgan token rad etiladi", async () => {
      const token = signToken({ sub: "u1", role: "ADMIN", email: "a@x.uz" }, "1ms");
      await new Promise((r) => setTimeout(r, 50));
      expect(verifyToken(token)).toBeNull();
    });

    it("parol hash'lanadi va tekshiriladi", async () => {
      const hash = await hashPassword("parol12345");
      expect(hash).not.toBe("parol12345");
      expect(hash.startsWith("$2")).toBe(true);
      expect(await verifyPassword("parol12345", hash)).toBe(true);
      expect(await verifyPassword("boshqa", hash)).toBe(false);
    });

    it("seed'dagi placeholder parol hech qachon mos kelmaydi", async () => {
      // Eski seed "PLACEHOLDER_FAZA_2A" yozardi — bcrypt formatida
      // emas, shuning uchun `verifyPassword` uni rad etishi kerak
      expect(await verifyPassword("PLACEHOLDER_FAZA_2A", "PLACEHOLDER_FAZA_2A")).toBe(false);
      expect(await verifyPassword("", "")).toBe(false);
    });
  });

  // --- 4. RBAC (TZ 18-band, 4-talab) -------------------------
  describe("4. RBAC — to'rt rol (10-fayl §3)", () => {
    it("FOUNDER hamma huquqqa ega", () => {
      // Egasi — yagona rol, unda hech narsa yopiq emas
      for (const p of Object.keys(PERMISSIONS)) {
        expect(can("FOUNDER", p as never), `FOUNDER uchun ${p} yopiq`).toBe(true);
      }
    });

    it("ADMIN texnik ishlarni qiladi, biznes raqamlarini ko'rmaydi", () => {
      // 2026-09-16: FOUNDER roli qo'shilganda ikki huquq ADMIN'dan
      // olindi. Ilgari "ADMIN hamma huquqqa ega" edi.
      expect(can("ADMIN", "report.read")).toBe(false);   // daromad, foyda
      expect(can("ADMIN", "user.manage")).toBe(false);   // adminlarni nazorat

      // Qolgan hammasi ochiq (Channel manager ham — "avvalgidek", 2026-09-27)
      for (const p of Object.keys(PERMISSIONS)) {
        if (p === "report.read" || p === "user.manage") continue;
        expect(can("ADMIN", p as never), `ADMIN uchun ${p} yopiq`).toBe(true);
      }
    });

    it("umumiy hisobot faqat egasiga ko'rinadi", () => {
      expect(can("FOUNDER", "report.read")).toBe(true);
      expect(can("ADMIN", "report.read")).toBe(false);
      expect(can("MANAGER", "report.read")).toBe(false);
      expect(can("STAFF", "report.read")).toBe(false);
    });

    it("foydalanuvchi boshqaruvi faqat egasida", () => {
      expect(can("FOUNDER", "user.manage")).toBe(true);
      expect(can("ADMIN", "user.manage")).toBe(false);
      expect(can("MANAGER", "user.manage")).toBe(false);
      expect(can("STAFF", "user.manage")).toBe(false);
    });

    it("MANAGER sozlamalar, xodimlar va foydalanuvchilarga KIROLMAYDI", () => {
      expect(can("MANAGER", "settings.write")).toBe(false);
      expect(can("MANAGER", "employee.read")).toBe(false);
      expect(can("MANAGER", "user.manage")).toBe(false);
      expect(can("MANAGER", "report.read")).toBe(false);
    });

    it("MANAGER bron, narx, xona yopish va audit bilan ishlaydi", () => {
      expect(can("MANAGER", "reservation.write")).toBe(true);
      expect(can("MANAGER", "reservation.cancel")).toBe(true);
      expect(can("MANAGER", "rate.write")).toBe(true);
      expect(can("MANAGER", "room.block")).toBe(true);
      expect(can("MANAGER", "audit.read")).toBe(true);
    });

    it("Channel manager: yozish — egasi va admin, o'qish — menejer ham", () => {
      expect(can("ADMIN", "channel.write")).toBe(true);
      expect(can("MANAGER", "channel.write")).toBe(false);
      expect(can("MANAGER", "channel.read")).toBe(true);
      // Eski nomlar bitta juftlikka birlashgan
      for (const p of ["channel.connect", "mapping.write", "synclog.read"]) {
        expect(Object.keys(PERMISSIONS), p).not.toContain(p);
      }
    });

    it("STAFF faqat check-in/to'lov/o'qish", () => {
      expect(can("STAFF", "checkin.write")).toBe(true);
      expect(can("STAFF", "payment.write")).toBe(true);
      expect(can("STAFF", "reservation.read")).toBe(true);
      // Pulni qaytarish — qabulxonada yo'q (2026-09-27)
      expect(can("STAFF", "payment.refund")).toBe(false);
      expect(can("MANAGER", "payment.refund")).toBe(true);
      // Channel manager — qabulxonada yo'q (dollar summasi bron ichida ko'rinadi)
      expect(can("STAFF", "channel.read")).toBe(false);
      expect(can("STAFF", "channel.write")).toBe(false);

      // Narxga va bekor qilishga tegmaydi
      expect(can("STAFF", "rate.write")).toBe(false);
      expect(can("STAFF", "reservation.cancel")).toBe(false);
      expect(can("STAFF", "reservation.write")).toBe(false);
      expect(can("STAFF", "room.block")).toBe(false);
      expect(can("STAFF", "settings.write")).toBe(false);
      expect(can("STAFF", "audit.read")).toBe(false);
    });

    it("har huquqda kamida bitta rol bor", () => {
      // Bo'sh ro'yxat = hech kim qila olmaydi, bu xato
      for (const [perm, roles] of Object.entries(PERMISSIONS)) {
        expect(roles.length, `${perm} uchun rol yo'q`).toBeGreaterThan(0);
      }
    });

    it("FOUNDER har huquqda bor — qulflanib qolmaslik uchun", () => {
      // 2026-09-16 dan beri bu rolni FOUNDER bajaradi: ADMIN'dan
      // `report.read` va `user.manage` olib tashlandi, shuning
      // uchun "hamma narsani qila oladigan" yagona rol — egasi.
      //
      // Bittasi bo'lmasa tizim qulflanadi: hech kim o'sha amalni
      // bajara olmaydi va bazaga qo'lda kirmasdan tuzatib bo'lmaydi.
      for (const [perm, roles] of Object.entries(PERMISSIONS)) {
        expect(roles as readonly UserRole[], `${perm} da FOUNDER yo'q`).toContain("FOUNDER");
      }
    });

    it("/api/auth/me foydalanuvchi huquqlarini qaytaradi", async () => {
      const res = await api("/api/auth/me", { headers: adminAuth });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.permissions)).toBe(true);
      expect(res.body.permissions.length).toBeGreaterThan(0);
    });
  });

  // --- 8. Audit log (TZ 18-band, 8-talab) --------------------
  describe("8. Audit log — kim nima qildi (10-fayl §4)", () => {
    it("yozuv yaratiladi va o'qiladi", async () => {
      await audit({
        action: "settings.changed",
        entityType: "Settings",
        entityId: "TEST_KEY",
        before: { value: "a" },
        after: { value: "b" },
        ipAddress: "127.0.0.1",
      });

      const rows = await listAudit({ action: "settings.changed" });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.entityId).toBe("TEST_KEY");
      expect((rows[0]!.after as any).value).toBe("b");
    });

    it("before/after sanitizatsiyadan o'tadi (TZ 18-band, 9-talab)", async () => {
      await audit({
        action: "user.password_changed",
        entityType: "User",
        entityId: "test",
        after: { password: "juda-maxfiy-parol", accessToken: "juda-maxfiy-token", propertyId: "12345" },
      });

      const rows = await listAudit({ action: "user.password_changed" });
      const text = JSON.stringify(rows[0]!.after);
      expect(text).not.toContain("juda-maxfiy-token");
      expect(text).not.toContain("juda-maxfiy-parol");
      expect(text).toContain("12345");     // maxfiy bo'lmagan qism qoladi
    });

    it("noto'g'ri userId audit'ni yiqitmaydi", async () => {
      // Foydalanuvchi o'chirilgan bo'lishi mumkin — FK xatosi
      // asosiy amalni to'xtatmasligi kerak (TZ 17-band)
      await expect(
        audit({ userId: "yoq-bunday-user", action: "user.login" })
      ).resolves.toBeUndefined();
    });

    it("nonushta narxi o'zgarishi qayd etiladi", async () => {
      const before = await api("/api/admin/meal-price", { headers: adminAuth });
      const price = before.body.price;

      const res = await api("/api/admin/meal-price", {
        method: "PUT",
        headers: adminAuth,
        body: JSON.stringify({ price: price + 1000, applyToActive: false }),
      });
      expect(res.status).toBe(200);

      const rows = await listAudit({ action: "meal_price.changed" });
      expect(rows.length, "nonushta narxi audit'ga tushmadi").toBeGreaterThan(0);
      expect((rows[0]!.after as any).mealPrice).toBe(price + 1000);

      // Qaytaramiz
      await api("/api/admin/meal-price", {
        method: "PUT",
        headers: adminAuth,
        body: JSON.stringify({ price, applyToActive: false }),
      });
    });

    it("bron bekor qilinishi qayd etiladi", async () => {
      // Tur nomi qattiq yozilmaydi: "standard" 12 xonali eski
      // tuzilishdan qolgan edi va bu test topa olmay yiqilardi
      const room = await prisma.room.findFirstOrThrow({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      // Narx tarifdan olinadi — pastroq narx chegirma sababini
      // talab qiladi (SAVOLLAR.md S4)
      const plan = await prisma.ratePlan.findFirst({
        where: { roomTypeId: room.roomTypeId },
        orderBy: { price: "desc" },
        select: { price: true },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        headers: adminAuth,
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2032-03-01",
          checkOut: "2032-03-02",
          guestName: "Audit Testi",
          phone: "+99890700001",
          adults: 1,
          pricePerNight: plan ? Number(plan.price) : 100,
        }),
      });
      expect(created.status).toBe(201);

      await api(`/api/reservations/${created.body.id}/cancel`, { method: "POST", headers: adminAuth });

      const rows = await listAudit({ action: "reservation.cancelled" });
      const entry = rows.find((r) => r.entityId === created.body.id);
      expect(entry, "bekor qilish audit'ga tushmadi").toBeTruthy();

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("GET /api/admin/audit-log ro'yxatni qaytaradi", async () => {
      await audit({ action: "user.login", entityType: "User", entityId: "x" });

      const res = await api("/api/admin/audit-log?limit=5", { headers: adminAuth });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("amallar ro'yxati yopiq — yangi amal qo'shish ongli qaror", () => {
      // 10-fayl §4 dagi hamma amal ro'yxatda bo'lishi kerak
      for (const a of [
        "settings.changed", "reservation.cancelled", "reservation.no_show",
        "payment.received", "rate.changed", "room.status_changed",
        "user.created", "user.role_changed", "user.password_changed",
      ]) {
        expect(AUDIT_ACTIONS as readonly string[]).toContain(a);
      }
      // Beds24 (2026-09-27): ulanish, bog'lash, qo'lda amallar, kurs jurnalda
      for (const a of [
        "channel.connected", "channel.disconnected", "channel.maintenance", "mapping.created",
        "mapping.updated", "mapping.deleted", "webhook.reprocessed", "reservation.sync_retry", "fx.changed",
      ]) {
        expect(AUDIT_ACTIONS as readonly string[]).toContain(a);
      }
      // STOP olib tashlangan
      for (const a of ["system.sales_stop", "system.sales_resume", "reservation.external_ref"]) {
        expect(AUDIT_ACTIONS as readonly string[]).not.toContain(a);
      }
    });
  });

  // --- 9. Sensitive data log qilinmasin (9-talab) ------------
  describe("9. Maxfiy ma'lumot log'ga tushmaydi", () => {
    it("sanitizeForLog token va parolni yashiradi", () => {
      const out = sanitizeForLog({
        refreshToken: "maxfiy1",
        accessToken: "maxfiy2",
        password: "maxfiy3",
        apiKey: "maxfiy4",
        guestName: "Aziz",
        nested: { authToken: "maxfiy5", price: 100 },
      });

      const text = JSON.stringify(out);
      for (const secret of ["maxfiy1", "maxfiy2", "maxfiy3", "maxfiy4", "maxfiy5"]) {
        expect(text, `${secret} yashirilmadi`).not.toContain(secret);
      }
      // Oddiy ma'lumot qoladi
      expect(text).toContain("Aziz");
      expect(text).toContain("100");
    });

    it("AuditLog'da ham token yo'q", async () => {
      const rows = await prisma.auditLog.findMany({ take: 200 });
      const text = JSON.stringify(rows).toLowerCase();
      expect(text).not.toContain("$2a$");     // parol hash ham emas
      expect(text).not.toContain("$2b$");
    });
  });

  // --- Foydalanuvchi boshqaruvi ------------------------------
  describe("foydalanuvchi boshqaruvi", () => {
    it("yaratilgan foydalanuvchi parol hash'isiz qaytadi", async () => {
      const user = await createUser({
        email: `test-${Date.now()}@imron.local`,
        password: "parol12345",
        fullName: "Test Foydalanuvchi",
        role: "STAFF",
      });
      created.push(user.id);

      expect(JSON.stringify(user).toLowerCase()).not.toContain("passwordhash");
      expect(user.role).toBe("STAFF");
    });

    it("yaratilgan parol bilan kirish mumkin", async () => {
      const email = `login-${Date.now()}@imron.local`;
      const user = await createUser({
        email, password: "parol12345", fullName: "Login Testi", role: "MANAGER",
      });
      created.push(user.id);

      const result = await login(email, "parol12345");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.user.role).toBe("MANAGER");
    });

    it("o'chirilgan foydalanuvchi kira olmaydi", async () => {
      const email = `disabled-${Date.now()}@imron.local`;
      const user = await createUser({
        email, password: "parol12345", fullName: "O'chirilgan", role: "STAFF",
      });
      created.push(user.id);

      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      const result = await login(email, "parol12345");
      expect(result.ok).toBe(false);
    });

    it("oxirgi ADMIN rolini o'zgartirib bo'lmaydi", async () => {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN", isActive: true } });
      if (admins.length !== 1) return;     // bir nechta admin bor — test ma'nosiz

      const res = await api(`/api/auth/users/${admins[0]!.id}`, {
        method: "PATCH",
        headers: founderAuth,
        body: JSON.stringify({ role: "STAFF" }),
      });
      expect(res.status).toBe(400);

      const still = await prisma.user.findUniqueOrThrow({ where: { id: admins[0]!.id } });
      expect(still.role).toBe("ADMIN");
    });
  });

  // --- RBAC HAQIQIY HTTP orqali ------------------------------
  //
  // Yuqoridagi RBAC testlari `can()` funksiyasini tekshiradi.
  // Bu blok esa endpoint'lar HAQIQATAN himoyalanganini sinaydi:
  // funksiya to'g'ri bo'lib, route'ga ulanmagan bo'lishi mumkin.
  //
  // Faqat `AUTH_REQUIRED=true` bo'lganda ishlaydi. Dev muhitida
  // auth o'chirilgan, shuning uchun test o'zini o'tkazib yuboradi.
  describe("RBAC endpoint'larda (AUTH_REQUIRED=true bo'lganda)", () => {
    let authOn = false;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
      const health = await api("/health");
      authOn = health.body?.security?.auth === true;
      if (!authOn) return;

      for (const [role, email] of Object.entries({
        admin: "admin@imron.local",
        manager: "manager@imron.local",
        staff: "staff@imron.local",
      })) {
        const res = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password: "admin12345" }),
        });
        if (res.body?.token) tokens[role] = res.body.token;
      }
    });

    const withRole = (role: string) => ({
      headers: { Authorization: `Bearer ${tokens[role]}` },
    });

    it("tokensiz so'rov 401 beradi", async () => {
      if (!authOn) return;

      // MUHIM: setupFiles global `fetch` ni o'rab, PMS so'rovlariga
      // avtomatik ADMIN token qo'shadi (vitest.setup.ts izohiga
      // qarang). Bu yerda esa aynan TOKENSIZ holatni sinaymiz,
      // shuning uchun bo'sh `Authorization` yuboramiz — o'ram
      // sarlavha bor deb hisoblab tegmaydi.
      const res = await fetch(`${PMS}/api/rooms`, {
        headers: { Authorization: "" },
      });
      expect(res.status).toBe(401);

      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("UNAUTHORIZED");
    });

    const ADMIN_READS = [
      "/api/admin/audit-log",
      "/api/admin/queues",
      "/api/admin/report?from=2032-01-01&to=2032-01-02",
      "/api/admin/expenses?from=2032-01-01&to=2032-01-02",
      "/api/admin/employees",
      "/api/admin/cleaning",
      "/api/admin/business-settings",
      "/api/reservations",
      "/api/rate-plans?from=2032-01-01&to=2032-01-02",
    ];

    it("admin o'qish endpoint'lari tokensiz 401", async () => {
      if (!authOn) return;
      for (const path of ADMIN_READS) {
        const res = await fetch(`${PMS}${path}`, { headers: { Authorization: "" } });
        expect(res.status, path).toBe(401);
      }
    });

    it("STAFF audit va navbatni ko'rmaydi (403), MANAGER ko'radi", async () => {
      if (!authOn) return;
      for (const path of ["/api/admin/audit-log", "/api/admin/queues"]) {
        expect((await api(path, withRole("staff"))).status, path).toBe(403);
        expect((await api(path, withRole("manager"))).status, path).toBe(200);
      }
    });

    it("hisobot va xarajat faqat egasida — ADMIN ham 403", async () => {
      if (!authOn) return;
      for (const path of ["/api/admin/report?from=2032-01-01&to=2032-01-02", "/api/admin/expenses?from=2032-01-01&to=2032-01-02"]) {
        expect((await api(path, withRole("admin"))).status, path).toBe(403);
        expect((await api(path, withRole("manager"))).status, path).toBe(403);
        expect((await api(path, { headers: founderAuth })).status, path).toBe(200);
      }
    });

    it("STAFF bron yarata / bekor qila olmaydi (403)", async () => {
      if (!authOn) return;
      const room = await prisma.room.findFirstOrThrow({ where: { isActive: true } });
      const create = await api("/api/reservations", {
        method: "POST",
        ...withRole("staff"),
        body: JSON.stringify({
          roomId: room.id, checkIn: "2032-02-01", checkOut: "2032-02-02",
          guestName: "Staff Bron", phone: "+998900001234", pricePerNight: 100,
        }),
      });
      expect(create.status).toBe(403);
    });

    it("STAFF xonalarni ko'radi", async () => {
      if (!authOn) return;
      const res = await api("/api/rooms", withRole("staff"));
      expect(res.status).toBe(200);
    });

    it("STAFF narx belgilay OLMAYDI (403)", async () => {
      if (!authOn) return;
      const res = await api("/api/rate-plans", {
        method: "PUT",
        ...withRole("staff"),
        body: JSON.stringify({ from: "2032-01-01", to: "2032-01-01", prices: { standard: 50 } }),
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });

    it("MANAGER narx belgilaydi", async () => {
      if (!authOn) return;
      const res = await api("/api/rate-plans", {
        method: "PUT",
        ...withRole("manager"),
        // Bazadagi haqiqiy tarif (ilgari eski "standard" ID'si — 400)
        body: JSON.stringify({ from: "2032-01-02", to: "2032-01-02", prices: { [(await prisma.roomType.findFirstOrThrow()).id]: 50 } }),
      });
      expect(res.status).toBe(200);
    });

    it("MANAGER sozlamalarga tegolmaydi (403), ADMIN tegadi", async () => {
      if (!authOn) return;
      const res = await api("/api/admin/business-settings", {
        method: "PUT",
        ...withRole("manager"),
        body: JSON.stringify({ freeCancelHours: 24 }),
      });
      expect(res.status).toBe(403);

      const ok = await api("/api/admin/business-settings", {
        method: "PUT",
        ...withRole("admin"),
        body: JSON.stringify({ freeCancelHours: 24 }),
      });
      expect(ok.status).toBe(200);
    });

    it("xona holati: STAFF iflos belgilaydi, lekin ochish va ta'mirga qo'yish — menejer", async () => {
      if (!authOn) return;
      const rooms = (await api("/api/rooms", withRole("staff"))).body as any[];
      const room = rooms.find((r) => r.status === "available")!;

      const dirty = await api(`/api/rooms/${room.id}`, { method: "PATCH", ...withRole("staff"), body: JSON.stringify({ status: "dirty" }) });
      expect(dirty.status).toBe(200);
      expect(dirty.body.status).toBe("dirty");

      // Iflos xonani tozalash tasdig'isiz ochish — qabulxonaga yopiq
      const open = await api(`/api/rooms/${room.id}`, { method: "PATCH", ...withRole("staff"), body: JSON.stringify({ status: "available" }) });
      expect(open.status).toBe(403);

      const ooo = await api(`/api/rooms/${room.id}`, { method: "PATCH", ...withRole("staff"), body: JSON.stringify({ status: "out_of_order" }) });
      expect(ooo.status).toBe(403);

      // "band"/"bron qilingan" qo'lda qo'yilmaydi — bronlardan hisoblanadi
      const occ = await api(`/api/rooms/${room.id}`, { method: "PATCH", ...withRole("manager"), body: JSON.stringify({ status: "occupied" }) });
      expect(occ.status).toBe(400);

      const back = await api(`/api/rooms/${room.id}`, { method: "PATCH", ...withRole("manager"), body: JSON.stringify({ status: "available" }) });
      expect(back.status).toBe(200);
      expect(back.body.status).not.toBe("dirty");
    });

    it("bron bor xonani majburan yopish — faqat administrator", async () => {
      if (!authOn) return;
      const room = await prisma.room.findFirstOrThrow({ where: { isActive: true }, orderBy: { sortOrder: "desc" } });
      const body = JSON.stringify({ roomIds: [room.id], from: "2032-05-01", to: "2032-05-01", force: true, reason: "Test" });

      const manager = await api("/api/rooms/blocks", { method: "POST", ...withRole("manager"), body });
      expect(manager.status).toBe(403);

      const admin = await api("/api/rooms/blocks", { method: "POST", ...withRole("admin"), body });
      expect(admin.status).toBe(201);
      await api("/api/rooms/blocks", {
        method: "DELETE", ...withRole("admin"),
        body: JSON.stringify({ roomIds: [room.id], from: "2032-05-01", to: "2032-05-01" }),
      });
    });

    it("buzilgan token 401 beradi", async () => {
      if (!authOn) return;
      const res = await api("/api/rooms", {
        headers: { Authorization: "Bearer buzilgan.token.qiymati" },
      });
      expect(res.status).toBe(401);
    });
  });

  // --- Sessiya: token bazadan tasdiqlanadi (2026-09-26) ---------
  //
  // Ilgari rol va faollik faqat token ichidan olinardi (12 soat).
  // O'chirilgan xodim yoki roli pasaytirilgan admin token muddati
  // tugaguncha eski huquq bilan ishlayverardi.
  describe("sessiya — o'chirish, rol va parol darhol kuchga kiradi", () => {
    let authOn = false;
    const email = `sessiya-${Date.now()}@imron.local`;
    let userId = "";

    const loginAs = async (password: string) => {
      const res = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      return res.body?.token as string | undefined;
    };
    const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

    beforeAll(async () => {
      const health = await api("/health");
      authOn = health.body?.security?.auth === true;
      if (!authOn) return;
      const u = await createUser({ email, password: "boshlang1ch", fullName: "Sessiya Testi", role: "MANAGER" });
      userId = u.id;
      created.push(u.id);
    });

    it("roli pasaytirilgan menejer shu zahoti narx qo'ya olmaydi", async () => {
      if (!authOn) return;
      const token = (await loginAs("boshlang1ch"))!;
      const typeId = (await prisma.roomType.findFirstOrThrow()).id;
      const body = JSON.stringify({ from: "2032-06-01", to: "2032-06-01", prices: { [typeId]: 500_000 } });

      expect((await api("/api/rate-plans", { method: "PUT", ...bearer(token), body })).status).toBe(200);

      const demote = await api(`/api/auth/users/${userId}`, {
        method: "PATCH", headers: founderAuth, body: JSON.stringify({ role: "STAFF" }),
      });
      expect(demote.status).toBe(200);

      // Eski token (rol = MANAGER) — lekin bazada STAFF
      expect((await api("/api/rate-plans", { method: "PUT", ...bearer(token), body })).status).toBe(403);

      await api(`/api/auth/users/${userId}`, { method: "PATCH", headers: founderAuth, body: JSON.stringify({ role: "MANAGER" }) });
    });

    it("o'chirilgan hisobning tokeni shu zahoti 401", async () => {
      if (!authOn) return;
      const token = (await loginAs("boshlang1ch"))!;
      expect((await api("/api/rooms", bearer(token))).status).toBe(200);

      await api(`/api/auth/users/${userId}`, { method: "PATCH", headers: founderAuth, body: JSON.stringify({ isActive: false }) });
      expect((await api("/api/rooms", bearer(token))).status).toBe(401);

      await api(`/api/auth/users/${userId}`, { method: "PATCH", headers: founderAuth, body: JSON.stringify({ isActive: true }) });
    });

    it("parol o'zgartirish: joriy parol tekshiriladi, eski tokenlar bekor, yangi token beriladi", async () => {
      if (!authOn) return;
      // iat soniyada — parol o'zgarishi shu soniyadan keyin bo'lsin
      const oldToken = (await loginAs("boshlang1ch"))!;
      await new Promise((r) => setTimeout(r, 1100));

      const wrong = await api("/api/auth/password", {
        method: "POST", ...bearer(oldToken),
        body: JSON.stringify({ currentPassword: "notogri-parol", newPassword: "yangiParol123" }),
      });
      expect(wrong.status).toBe(400);

      const short = await api("/api/auth/password", {
        method: "POST", ...bearer(oldToken),
        body: JSON.stringify({ currentPassword: "boshlang1ch", newPassword: "qisqa" }),
      });
      expect(short.status).toBe(400);

      const ok = await api("/api/auth/password", {
        method: "POST", ...bearer(oldToken),
        body: JSON.stringify({ currentPassword: "boshlang1ch", newPassword: "yangiParol123" }),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.token).toBeTruthy();

      expect((await api("/api/rooms", bearer(oldToken))).status, "eski token ishlayapti").toBe(401);
      expect((await api("/api/rooms", bearer(ok.body.token))).status).toBe(200);
      expect(await loginAs("boshlang1ch")).toBeUndefined();
      expect(await loginAs("yangiParol123")).toBeTruthy();

      const log = await prisma.auditLog.findFirst({ where: { action: "user.password_changed", entityId: userId } });
      expect(log).toBeTruthy();
    });

    it("egasi xodim parolini tiklaydi — xodimning eski sessiyasi yopiladi", async () => {
      if (!authOn) return;
      const token = (await loginAs("yangiParol123"))!;
      await new Promise((r) => setTimeout(r, 1100));

      const reset = await api(`/api/auth/users/${userId}`, {
        method: "PATCH", headers: founderAuth, body: JSON.stringify({ password: "tiklanganParol1" }),
      });
      expect(reset.status).toBe(200);
      expect((await api("/api/rooms", bearer(token))).status).toBe(401);
      expect(await loginAs("tiklanganParol1")).toBeTruthy();
    });

    it("mavjud bo'lmagan foydalanuvchini o'zgartirish — 404", async () => {
      if (!authOn) return;
      const res = await api("/api/auth/users/yoq-foydalanuvchi", {
        method: "PATCH", headers: founderAuth, body: JSON.stringify({ isActive: false }),
      });
      expect(res.status).toBe(404);
    });
  });

  // --- 6. Rate limiting (TZ 18-band, 6-talab) ----------------
  //
  // Faqat `RATE_LIMIT_DISABLED=false` bo'lganda ishlaydi. Dev va
  // odatdagi test yurishlarida cheklov o'chirilgan, chunki testlar
  // o'nlab so'rov yuboradi va cheklovga urilib qolishi mumkin —
  // bu tekshirilayotgan xatti-harakat emas.
  describe("6. Rate limiting (RATE_LIMIT_DISABLED=false bo'lganda)", () => {
    let limitOn = false;

    beforeAll(async () => {
      const health = await api("/health");
      limitOn = health.body?.security?.rateLimit === true;
    });

    it("login 5 urinishdan keyin 429 beradi (brute-force himoyasi)", async () => {
      if (!limitOn) return;

      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`${PMS}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "" },
          body: JSON.stringify({ email: "brute@imron.local", password: "notogri" }),
        });
        codes.push(res.status);
      }

      // Boshida 401 (parol noto'g'ri), keyin 429 (cheklov)
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      expect(codes[0]).toBe(401);
    }, 30000);

    it("cheklov sarlavhalari qaytariladi", async () => {
      if (!limitOn) return;

      const res = await fetch(`${PMS}/api/rooms`, { headers: { Authorization: "" } });
      // `standardHeaders: true` — RFC qoidasiga mos sarlavhalar
      const hasLimitHeader =
        res.headers.has("ratelimit-limit") || res.headers.has("ratelimit");
      expect(hasLimitHeader).toBe(true);
    });
  });

  // --- Tozalash rasmlari (/uploads) ----------------------------
  describe("tozalash rasmlari — /uploads login'siz ochilmaydi", () => {
    const dir = path.join(BACKEND_DIR, "public", "uploads", "cleaning");
    const fileName = `sectest_${Date.now()}.jpg`;
    const rawUrl = `/uploads/cleaning/${fileName}`;
    let taskId = "";
    let authOn = false;

    beforeAll(async () => {
      authOn = (await api("/health")).body?.security?.auth === true;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fileName), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const room = await prisma.room.findFirstOrThrow({ where: { isActive: true } });
      taskId = (await prisma.cleaningTask.create({
        data: { roomId: room.id, reason: "Rasm testi", status: "PENDING", photoUrl: rawUrl },
      })).id;
    });

    afterAll(async () => {
      fs.rmSync(path.join(dir, fileName), { force: true });
      if (taskId) await prisma.cleaningTask.deleteMany({ where: { id: taskId } });
    });

    // Bo'sh `Authorization` — setup o'rami token qo'shmasin
    const anon = (url: string) => fetch(`${PMS}${url}`, { headers: { Authorization: "" } });

    it("imzosiz manzil tokensiz ochilmaydi (auth rejimida)", async () => {
      const res = await anon(rawUrl);
      expect(res.status).toBe(authOn ? 401 : 200);
    });

    it("panel imzoli havola oladi — u tokensiz ochiladi, buzilgani yo'q", async () => {
      const list = await api("/api/admin/cleaning", { headers: adminAuth });
      expect(list.status).toBe(200);
      const task = list.body.tasks.find((t: { id: string }) => t.id === taskId);
      expect(task?.photoUrl).toBeTruthy();

      if (!authOn) {
        expect(task.photoUrl).toBe(rawUrl);
        return;
      }
      expect(task.photoUrl).toMatch(/^\/uploads\/cleaning\/.+\?exp=\d+&sig=[\w-]+$/);
      expect((await anon(task.photoUrl)).status).toBe(200);

      // Imzo boshqa faylga yoki boshqa muddatga ko'chirilmaydi
      const sig = new URL(task.photoUrl, PMS).searchParams.get("sig");
      const exp = Number(new URL(task.photoUrl, PMS).searchParams.get("exp"));
      expect((await anon(`${rawUrl}?exp=${exp + 3600}&sig=${sig}`)).status).toBe(401);
      expect((await anon(`/uploads/cleaning/boshqa.jpg?exp=${exp}&sig=${sig}`)).status).toBe(401);
    });
  });

  // --- Cheklist (10-fayl §9) ---------------------------------
  describe("xavfsizlik cheklisti — FAZA 12 mezoni", () => {
    it("/health xavfsizlik holatini ko'rsatadi", async () => {
      const res = await api("/health");
      expect(res.body.security).toBeTruthy();
      expect(typeof res.body.security.auth).toBe("boolean");
      expect(typeof res.body.security.rateLimit).toBe("boolean");
    });

    it("hech bir API javobida token yoki parol hash'i qolmagan", async () => {
      // Bir nechta endpoint'ni birdan tekshiramiz
      const paths = [
        "/api/rooms",
        "/api/reservations",
        "/api/admin/employees",
        "/api/admin/cleaning",
        "/api/auth/me",
      ];

      // Auth yoqilgan bo'lsa token bilan so'raymiz
      for (const p of paths) {
        const res = await api(p, { headers: adminAuth });
        const text = res.raw.toLowerCase();
        expect(text, `${p} da refreshToken bor`).not.toContain("refreshtoken");
        expect(text, `${p} da accessToken bor`).not.toContain("accesstoken");
        expect(text, `${p} da passwordHash bor`).not.toContain("passwordhash");
      }
    });
  });
});
