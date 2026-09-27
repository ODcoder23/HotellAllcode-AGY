/**
 * Yuklangan fayllarga kirish (tozalash rasmlari, `/uploads`)
 *
 * MUAMMO (2026-09-28 gacha): `/uploads` login'siz ochiq edi — manzilni
 * bilgan har kim xona rasmini ko'ra olardi.
 *
 * NEGA JWT EMAS: admin panel rasmni `<img src>` bilan ko'rsatadi,
 * brauzer esa rasm so'roviga `Authorization` sarlavhasini qo'shmaydi.
 * Shuning uchun API rasm manzilini qisqa muddatli IMZO bilan beradi:
 *
 *   /uploads/cleaning/<fayl>.jpg?exp=<unix soniya>&sig=<HMAC>
 *
 * Imzo `JWT_SECRET` dan olingan kalit bilan — faqat server yasaydi.
 * Muddat soat boshiga yaxlitlanadi: panel ro'yxatni qayta o'qisa ham
 * manzil bir soat davomida bir xil qoladi va brauzer keshi ishlaydi.
 *
 * Imzosiz so'rov ham o'tadi, agar Bearer token haqiqiy bo'lsa (API
 * mijozlari uchun). `AUTH_REQUIRED=false` — hammasi ochiq, qolgan
 * API kabi.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { requireAuth } from "./authMiddleware.js";

/** Havola kamida shuncha amal qiladi (JWT muddati bilan bir xil) */
const TTL_SECONDS = 12 * 3600;
const HOUR = 3600;

function signature(path: string, exp: number): string {
  return createHmac("sha256", config.jwtSecret)
    .update(`uploads:${path}:${exp}`)
    .digest("base64url");
}

/**
 * `/uploads/...` manzilini imzolaydi. Boshqa manzil (tashqi URL,
 * data-URL, bo'sh) o'zgarishsiz qaytadi.
 */
export function signUploadUrl<T extends string | null | undefined>(url: T, now = Date.now()): T {
  if (!url || !url.startsWith("/uploads/") || !config.authRequired) return url;
  const path = url.split("?")[0];
  const exp = Math.ceil((now / 1000 + TTL_SECONDS) / HOUR) * HOUR;
  return `${path}?exp=${exp}&sig=${signature(path, exp)}` as T;
}

/** Imzo va muddat to'g'rimi */
export function verifyUploadSignature(path: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  if (typeof exp !== "string" || typeof sig !== "string" || !/^\d{1,12}$/.test(exp)) return false;
  const expNum = Number(exp);
  if (expNum * 1000 < now) return false;
  const expected = Buffer.from(signature(path, expNum));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * `/uploads` uchun middleware: imzoli havola yoki haqiqiy token.
 * `app.use("/uploads", uploadAccess, express.static(...))`.
 */
export function uploadAccess(req: Request, res: Response, next: NextFunction): void {
  if (!config.authRequired) { next(); return; }
  const path = req.baseUrl + req.path;
  if (verifyUploadSignature(path, req.query.exp, req.query.sig)) { next(); return; }
  requireAuth(req, res, next);
}
