/**
 * Beds24 HTTP mijozi — YAGONA CHIQISH NUQTASI
 *
 * Bu fayldan tashqarida hech qayerda Beds24 API'ga `fetch` chaqirilmaydi
 * (ulanish — `auth.ts`). Maqsad: kredit va qayta urinish mantig'ini
 * bitta joyda ushlab turish.
 *
 * KREDIT: hisob darajasida, 5 daqiqalik aylanma oyna, ~100 kredit. Har
 * javobda: `x-five-min-limit-remaining`, `x-five-min-limit-resets-in`,
 * `x-request-cost`.
 *
 * Kredit tugashi — XATO EMAS: job kechiktiriladi va `attempts` hisobiga
 * kirmaydi (queues/workers.ts). Aks holda normal yuklamada job'lar
 * bekorga "failed" bo'lib qolardi.
 */

import { config } from "../../lib/config.js";
import { getAccessToken, invalidateToken } from "./auth.js";

// --- Kredit holati (jarayon xotirasida) ---------------------
export type CreditState = {
  remaining: number | null;
  resetsIn: number | null;
  lastCost: number | null;
  updatedAt: string | null;
};

let credits = { remaining: config.beds24.creditLimit, resetsIn: 0, lastCost: 0, updatedAt: 0 };

export function getCreditState(): CreditState & { isLow: boolean } {
  const known = credits.updatedAt > 0;
  return {
    remaining: known ? credits.remaining : null,
    resetsIn: known ? credits.resetsIn : null,
    lastCost: known ? credits.lastCost : null,
    updatedAt: known ? new Date(credits.updatedAt).toISOString() : null,
    isLow: known && credits.remaining < config.beds24.creditSafetyThreshold,
  };
}

/** Kredit "tugagan" paytda shuncha vaqtda bir marta sinov so'rovi */
const PROBE_AFTER_MS = 30_000;
let lastProbeAt = 0;

// --- Xatolar ------------------------------------------------

/**
 * Kredit tugagan. `retryAfterSeconds` — qancha kutish kerak.
 * BullMQ bu xatoni ko'rib job'ni kechiktiradi, failed deb belgilamaydi.
 */
export class RateLimitError extends Error {
  readonly retryable = true;
  constructor(readonly retryAfterSeconds: number) {
    super(`Beds24 kredit tugadi, ${retryAfterSeconds}s kutish kerak`);
    this.name = "RateLimitError";
  }
}

export class Beds24ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "Beds24ApiError";
  }
}

// --- So'rov -------------------------------------------------

type RequestOptions = {
  method?: "GET" | "POST";
  /**
   * Massiv qiymat takroriy parametr bo'lib ketadi:
   * `{status: ["confirmed","cancelled"]}` -> `?status=confirmed&status=cancelled`
   */
  query?: Record<string, string | number | boolean | Array<string | number> | undefined>;
  body?: unknown;
  /** Taxminiy kredit qiymati — oldindan tekshirish uchun */
  estimatedCost?: number;
  /** 401 kelganda token yangilanib qayta urinilganmi */
  _retriedAuth?: boolean;
};

/**
 * Beds24'ga so'rov yuboradi.
 *
 * Oldindan tekshiradi: kredit yetarlimi. Yetmasa darhol
 * `RateLimitError` — bekorga so'rov yuborilmaydi. Mahalliy holat
 * eskirishi mumkin (oyna aylanma), shuning uchun PROBE_AFTER_MS da
 * bitta sinov so'rovi o'tkaziladi.
 */
export async function beds24Request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, estimatedCost = 1 } = opts;

  if (credits.updatedAt > 0) {
    const elapsed = (Date.now() - credits.updatedAt) / 1000;
    const windowExpired = elapsed > credits.resetsIn;

    if (!windowExpired && credits.remaining < estimatedCost) {
      const now = Date.now();
      if (now - Math.max(credits.updatedAt, lastProbeAt) < PROBE_AFTER_MS) {
        throw new RateLimitError(Math.max(1, Math.ceil(credits.resetsIn - elapsed)));
      }
      lastProbeAt = now;
    }
  }

  // --- URL ---
  const url = new URL(`${config.beds24.baseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const token = await getAccessToken();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const msg = String(e);
    const isTimeout = msg.includes("timeout") || msg.includes("aborted");
    throw new Beds24ApiError(
      0,
      isTimeout ? "Beds24 javob bermadi (20 soniya)" : `Tarmoq xatosi: ${msg.slice(0, 100)}`,
      true
    );
  }

  // --- Kredit sarlavhalari ---
  const remaining = res.headers.get("x-five-min-limit-remaining");
  if (remaining !== null) {
    credits = {
      remaining: Number(remaining),
      resetsIn: Number(res.headers.get("x-five-min-limit-resets-in") ?? 300),
      lastCost: Number(res.headers.get("x-request-cost") ?? 0),
      updatedAt: Date.now(),
    };
    if (credits.remaining < config.beds24.creditSafetyThreshold) {
      console.warn(`[beds24] kredit kam: ${credits.remaining}, ${credits.resetsIn}s ichida tiklanadi`);
    }
  }

  // --- 429: kredit tugadi ---
  if (res.status === 429) {
    const bodyJson = await res.json().catch(() => ({}) as Record<string, unknown>);
    const wait = Number((bodyJson as { resetsIn?: number }).resetsIn ?? credits.resetsIn ?? 60);
    throw new RateLimitError(Math.max(1, wait));
  }

  // --- 401: token eskirgan, bir marta yangilab qayta urinish ---
  if (res.status === 401 && !opts._retriedAuth) {
    await invalidateToken();
    return beds24Request<T>(path, { ...opts, _retriedAuth: true });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Yangi token bilan ham 401 — token emas, RUXSAT (scope) muammosi:
    // Beds24 yetishmagan scope uchun ham "Token not valid" qaytaradi
    const hint = res.status === 401
      ? " — token yangilangan, demak bu amal uchun ruxsat (scope) yetishmaydi (Beds24 panelida tekshiring)"
      : "";
    throw new Beds24ApiError(
      res.status,
      `Beds24 ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}${hint}`,
      res.status >= 500,
      text
    );
  }

  const text = await res.text();
  if (!text) throw new Beds24ApiError(res.status, "Beds24 bo'sh javob qaytardi", true);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Beds24ApiError(res.status, `Beds24 noto'g'ri JSON qaytardi: ${text.slice(0, 120)}`, true);
  }
}
