/**
 * Maxfiy qiymatlarni shifrlash — TZ 18-band
 *
 * Beds24 `refreshToken` va `accessToken` bazada shifrlangan holda
 * saqlanadi. Kalit faqat `.env` da (`ENCRYPTION_KEY`), repoga kirmaydi.
 *
 * AES-256-GCM: shifrlash + autentifikatsiya birga — shifrlangan matn
 * o'zgartirilsa deshifrlash xato beradi.
 *
 * Format:  base64(iv) : base64(authTag) : base64(ciphertext)
 */

import crypto from "node:crypto";
import { config } from "./config.js";
import { ValidationError } from "./errors.js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getKey(): Buffer {
  const hex = config.encryptionKey;
  if (!hex) {
    throw new ValidationError(
      "Serverda ENCRYPTION_KEY yo'q — Beds24 tokenini xavfsiz saqlab bo'lmaydi. " +
      "Yaratish: openssl rand -hex 32 (SERVER.md)"
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new ValidationError(`ENCRYPTION_KEY 64 hex belgi bo'lishi kerak (hozir ${key.length} bayt)`);
  }
  return key;
}

/** Kalit sozlanganmi — ulanish sahifasi oldindan ogohlantiradi */
export function hasEncryptionKey(): boolean {
  try { getKey(); return true; } catch { return false; }
}

export function encrypt(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Shifrlangan qiymat formati noto'g'ri");

  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
