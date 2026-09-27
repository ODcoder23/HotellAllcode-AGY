/**
 * Beds24 API v2 mijozi — FAQAT O'QISH (kanal kuzatuvi, 2026-09-27)
 *
 * YAGONA CHIQISH NUQTASI: Beds24'ga hamma so'rov shu fayldan o'tadi.
 * Ataylab faqat `GET` — PMS Beds24'ga hech narsa yozmaydi (egasi
 * qarori: kuzatuv rejimi). `POST`/`DELETE` funksiyasi umuman yo'q,
 * tasodifan yozib yuborish imkonsiz.
 *
 * Real API faktlari (BEDS24.md, "Real API faktlari"):
 *   - access token 24 soat, `refreshToken` bilan olinadi
 *   - javobda yangi `refreshToken` kelishi mumkin — eskisi o'sha
 *     zahoti o'ladi, yangisi DARHOL saqlanishi shart
 *   - scope yetishmasa ham 401 "Token not valid"
 *   - kredit: 5 daqiqada ~100, har javobda `X-Five-Min-Limit-*`
 */

import { prisma } from "../../lib/prisma.js";
import { config } from "../../lib/config.js";
import { encrypt, decrypt } from "../../lib/encryption.js";

/** Muddati tugashiga shuncha qolganda token yangilanadi */
const REFRESH_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

export class Beds24Error extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "Beds24Error";
  }
}

// ============================================================
//  Kredit holati (jarayon xotirasida)
// ============================================================

export type CreditState = {
  remaining: number | null;
  resetsIn: number | null;
  lastCost: number | null;
  updatedAt: string | null;
};

let credits: CreditState = { remaining: null, resetsIn: null, lastCost: null, updatedAt: null };

export function getCreditState(): CreditState {
  return { ...credits };
}

function readCredits(res: Response): void {
  const remaining = res.headers.get("x-five-min-limit-remaining");
  if (remaining === null) return;
  credits = {
    remaining: Number(remaining),
    resetsIn: Number(res.headers.get("x-five-min-limit-resets-in") ?? 0),
    lastCost: Number(res.headers.get("x-request-cost") ?? 0),
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================
//  Ulanish (token)
// ============================================================

/** Kanal yozuvi — bir marta yaratiladi */
export async function getBeds24Channel() {
  return prisma.channel.upsert({
    where: { code: "beds24" },
    create: { code: "beds24", name: "Beds24" },
    update: {},
  });
}

export async function activeConnection() {
  return prisma.channelConnection.findFirst({
    where: { channel: { code: "beds24" }, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
}

async function rawGet(path: string, headers: Record<string, string>, query?: URLSearchParams): Promise<Response> {
  const url = `${config.beds24.baseUrl}${path}${query && [...query].length ? `?${query}` : ""}`;
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    readCredits(res);
    return res;
  } catch (e) {
    const msg = String(e);
    throw new Beds24Error(
      msg.includes("timeout") || msg.includes("abort")
        ? "Beds24 javob bermadi (20 soniya)"
        : `Beds24'ga ulanib bo'lmadi: ${msg.slice(0, 120)}`
    );
  }
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Beds24Error(`${what}: Beds24 ${res.status} — ${text.slice(0, 200)}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Beds24Error(`${what}: Beds24 noto'g'ri JSON qaytardi`, res.status);
  }
}

type TokenResponse = { token?: string; expiresIn?: number; refreshToken?: string };

/**
 * Yangi ulanish: invite code YOKI tayyor refresh token.
 *
 * Invite code bir martalik (`GET /authentication/setup`). Refresh
 * token berilsa darhol access token olinadi — token haqiqiyligi shu
 * yerda tekshiriladi, noto'g'ri token bazaga yozilmaydi.
 */
export async function connect(input: { inviteCode?: string; refreshToken?: string; propertyId?: string }) {
  let tokens: TokenResponse;
  if (input.inviteCode) {
    tokens = await readJson<TokenResponse>(
      await rawGet("/authentication/setup", { code: input.inviteCode.trim() }),
      "Invite code"
    );
  } else if (input.refreshToken) {
    const refreshToken = input.refreshToken.trim();
    tokens = await readJson<TokenResponse>(
      await rawGet("/authentication/token", { refreshToken }),
      "Refresh token"
    );
    tokens.refreshToken = tokens.refreshToken || refreshToken;
  } else {
    throw new Beds24Error("Invite code yoki refresh token kerak", 400);
  }

  if (!tokens.token || !tokens.refreshToken) {
    throw new Beds24Error("Beds24 token qaytarmadi — kod yoki token yaroqsiz", 400);
  }

  // Obyekt ID berilmasa — hisobdagi birinchi obyekt; berilsa — mavjudligi
  // tekshiriladi (noto'g'ri ID bilan ulanib qolmaslik uchun)
  const props = await readJson<{ data?: Array<{ id: number }> }>(
    await rawGet("/properties", { token: tokens.token }),
    "Obyektlar"
  );
  const ids = (props.data ?? []).map((p) => String(p.id));
  let propertyId = input.propertyId?.trim();
  if (!propertyId) {
    if (!ids[0]) throw new Beds24Error("Hisobda obyekt (property) topilmadi", 400);
    propertyId = ids[0];
  } else if (!ids.includes(propertyId)) {
    throw new Beds24Error(`Hisobda ${propertyId} obyekti yo'q (bor: ${ids.join(", ") || "—"})`, 400);
  }

  const channel = await getBeds24Channel();
  const expiresAt = new Date(Date.now() + (tokens.expiresIn ?? 86_400) * 1000);

  // Faqat bitta faol ulanish
  await prisma.channelConnection.updateMany({
    where: { channelId: channel.id, NOT: { propertyId } },
    data: { isActive: false, accessToken: null, accessTokenExpiresAt: null },
  });

  return prisma.channelConnection.upsert({
    where: { channelId_propertyId: { channelId: channel.id, propertyId } },
    create: {
      channelId: channel.id,
      propertyId,
      refreshToken: encrypt(tokens.refreshToken),
      accessToken: encrypt(tokens.token),
      accessTokenExpiresAt: expiresAt,
      isActive: true,
    },
    update: {
      refreshToken: encrypt(tokens.refreshToken),
      accessToken: encrypt(tokens.token),
      accessTokenExpiresAt: expiresAt,
      isActive: true,
      lastError: null,
    },
  });
}

/** Ulanishni o'chirish — tokenlar bazadan o'chiriladi */
export async function disconnect(): Promise<number> {
  const r = await prisma.channelConnection.updateMany({
    where: { channel: { code: "beds24" }, isActive: true },
    data: { isActive: false, accessToken: null, accessTokenExpiresAt: null, refreshToken: "" },
  });
  return r.count;
}

/**
 * Parallel yangilashlar bittaga birlashtiriladi: refresh token
 * almashadigan bo'lsa, ikki so'rov bir vaqtda yangilasa ikkinchisi
 * o'lik token bilan qoladi va ulanish butunlay uziladi.
 */
let refreshing: Promise<string> | null = null;

async function getAccessToken(force = false): Promise<string> {
  const conn = await activeConnection();
  if (!conn || !conn.refreshToken) {
    throw new Beds24Error("Beds24 ulanmagan — Channel manager → Ulangan kanallar", 400);
  }

  const expiresAt = conn.accessTokenExpiresAt?.getTime() ?? 0;
  if (!force && conn.accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decrypt(conn.accessToken);
  }

  if (!refreshing) {
    refreshing = (async () => {
      const res = await rawGet("/authentication/token", { refreshToken: decrypt(conn.refreshToken) });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        await prisma.channelConnection.update({
          where: { id: conn.id },
          data: { lastCheckOk: false, lastError: `Token yangilanmadi (${res.status})`, lastCheckedAt: new Date() },
        });
        throw new Beds24Error(
          `Token yangilanmadi (${res.status}): ${text.slice(0, 120)}. ` +
          "Refresh token o'lgan bo'lishi mumkin — qayta ulang.",
          res.status
        );
      }
      const body = (await res.json()) as TokenResponse;
      if (!body.token) throw new Beds24Error("Beds24 access token qaytarmadi");

      await prisma.channelConnection.update({
        where: { id: conn.id },
        data: {
          accessToken: encrypt(body.token),
          accessTokenExpiresAt: new Date(Date.now() + (body.expiresIn ?? 86_400) * 1000),
          // Yangi refresh token keldi — eskisi o'ldi, darhol saqlaymiz
          ...(body.refreshToken ? { refreshToken: encrypt(body.refreshToken) } : {}),
        },
      });
      return body.token;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/**
 * Beds24'dan o'qish (GET). 401 kelsa token bir marta yangilanadi.
 *
 * `query` qiymati massiv bo'lsa parametr takrorlanadi
 * (`status=confirmed&status=cancelled`).
 */
export async function beds24Get<T>(
  path: string,
  query: Record<string, string | number | boolean | Array<string> | undefined> = {}
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.set(k, String(v));
  }

  let token = await getAccessToken();
  let res = await rawGet(path, { token }, q);

  if (res.status === 401) {
    token = await getAccessToken(true);
    res = await rawGet(path, { token }, q);
    if (res.status === 401) {
      throw new Beds24Error(
        "Beds24 401: yangi token bilan ham rad etildi — token ruxsatlari (scope) yetarli emas",
        401
      );
    }
  }
  if (res.status === 429) {
    throw new Beds24Error("Beds24 kredit limiti tugadi — bir necha daqiqadan keyin qayta urinib ko'ring", 429);
  }
  return readJson<T>(res, `GET ${path}`);
}
