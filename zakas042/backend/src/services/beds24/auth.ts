/**
 * Beds24 autentifikatsiya va ulanish
 *
 * Oqim:
 *   1. Beds24 panelida invite code yaratiladi (yoki tayyor refresh token)
 *   2. Admin panel -> Channel manager -> Ulash:
 *        GET /authentication/setup  (header: code) -> refreshToken
 *        yoki GET /authentication/token (header: refreshToken)
 *   3. Keyingi so'rovlarda header: token (24 soatlik access token)
 *
 * Access token DB'da kesh qilinadi va muddati tugashiga yaqin yangilanadi
 * — har so'rovga yangi token olish kredit sarflaydi.
 *
 * REFRESH TOKEN ALMASHADI (real hisobda kuzatilgan): javobda BA'ZAN
 * yangi `refreshToken` keladi va eskisi o'sha zahoti "Token not valid"
 * bo'ladi. Yangisi darhol saqlanadi, parallel yangilashlar bittaga
 * birlashtiriladi. Refresh token 30 kun ishlatilmasa o'ladi — davriy
 * polling uni tirik tutadi.
 *
 * Token'lar AES-256-GCM bilan shifrlangan holda saqlanadi (TZ 18-band).
 */

import { prisma } from "../../lib/prisma.js";
import { config } from "../../lib/config.js";
import { encrypt, decrypt, hasEncryptionKey } from "../../lib/encryption.js";

/** Muddati tugashiga shu vaqt qolganda yangilanadi (5 daqiqa zaxira) */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export class Beds24AuthError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "Beds24AuthError";
  }
}

type TokenResponse = { token?: string; expiresIn?: number; refreshToken?: string };

/** Beds24 xato javobidan matnni ajratadi: `{success:false,error:"..."}` */
async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: string };
    if (j.error) return j.error;
  } catch { /* JSON emas */ }
  return text.slice(0, 120);
}

async function authGet(path: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${config.beds24.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const msg = String(e);
    throw new Beds24AuthError(
      msg.includes("timeout") || msg.includes("abort")
        ? "Beds24 javob bermadi (20 soniya)"
        : `Beds24'ga ulanib bo'lmadi: ${msg.slice(0, 120)}`,
      true
    );
  }
}

/** `GET /authentication/token` — javobni o'zgartirmasdan qaytaradi */
async function requestToken(refreshToken: string): Promise<Required<Pick<TokenResponse, "token" | "expiresIn">> & TokenResponse> {
  const res = await authGet("/authentication/token", { refreshToken });
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new Beds24AuthError(
      `Token yangilanmadi (${res.status}: ${await errorText(res)}). ` +
      (retryable
        ? "Vaqtinchalik muammo, qayta urinib ko'riladi."
        : "Refresh token yaroqsiz — Beds24 panelida yangi invite code olib qayta ulang."),
      retryable
    );
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.token) throw new Beds24AuthError("Beds24 token qaytarmadi", true);
  return { ...body, token: body.token, expiresIn: body.expiresIn ?? 86_400 };
}

// ============================================================
//  Kanal va ulanish yozuvlari
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

/**
 * Yangi ulanish: invite code YOKI tayyor refresh token.
 *
 * TARTIB MUHIM:
 *   1. Shifrlash kaliti — Beds24'ga so'rovdan OLDIN. Invite code bir
 *      martalik: kalitsiz ulansa kod yonib, token saqlanmay qolardi.
 *   2. Kod/token -> access token (haqiqiyligi shu yerda tekshiriladi)
 *   3. Obyekt: berilmasa hisobdagi birinchisi; berilsa mavjudligi
 *      tekshiriladi (noto'g'ri ID bilan ulanib qolmaslik uchun)
 */
export async function connect(input: { inviteCode?: string; refreshToken?: string; propertyId?: string }) {
  if (!hasEncryptionKey()) {
    throw new Beds24AuthError(
      "Serverda ENCRYPTION_KEY yo'q — avval uni .env ga qo'shing (openssl rand -hex 32). " +
      "Invite code ishlatilmadi.",
      false
    );
  }

  let tokens: { token: string; expiresIn: number; refreshToken: string };
  if (input.inviteCode) {
    const res = await authGet("/authentication/setup", { code: input.inviteCode.trim() });
    if (!res.ok) {
      throw new Beds24AuthError(`Invite code qabul qilinmadi (${res.status}): ${await errorText(res)}`, false);
    }
    const body = (await res.json()) as TokenResponse;
    if (!body.token || !body.refreshToken) {
      throw new Beds24AuthError("Beds24 token qaytarmadi — kod yaroqsiz", false);
    }
    tokens = { token: body.token, expiresIn: body.expiresIn ?? 86_400, refreshToken: body.refreshToken };
  } else if (input.refreshToken) {
    const given = input.refreshToken.trim();
    const body = await requestToken(given);
    // Beds24 shu so'rovning o'zida tokenni almashtirishi mumkin
    tokens = { token: body.token, expiresIn: body.expiresIn, refreshToken: body.refreshToken || given };
  } else {
    throw new Beds24AuthError("Invite code yoki refresh token kerak", false);
  }

  // Obyektlar — yangi token bilan to'g'ridan-to'g'ri (ulanish hali saqlanmagan)
  const propsRes = await authGet("/properties", { token: tokens.token });
  if (!propsRes.ok) {
    throw new Beds24AuthError(`Obyektlar o'qilmadi (${propsRes.status}): ${await errorText(propsRes)}`, false);
  }
  const props = (await propsRes.json()) as { data?: Array<{ id: number }> };
  const ids = (props.data ?? []).map((p) => String(p.id));
  let propertyId = input.propertyId?.trim();
  if (!propertyId) {
    if (!ids[0]) throw new Beds24AuthError("Hisobda obyekt (property) topilmadi", false);
    propertyId = ids[0];
  } else if (!ids.includes(propertyId)) {
    throw new Beds24AuthError(`Hisobda ${propertyId} obyekti yo'q (bor: ${ids.join(", ") || "—"})`, false);
  }

  const channel = await prisma.channel.upsert({
    where: { code: "beds24" },
    create: { code: "beds24", name: "Beds24", isActive: true },
    update: { isActive: true },
  });

  // Faqat bitta faol ulanish
  await prisma.channelConnection.updateMany({
    where: { channelId: channel.id, NOT: { propertyId } },
    data: { isActive: false, accessToken: null, accessTokenExpiresAt: null },
  });

  const data = {
    refreshToken: encrypt(tokens.refreshToken),
    accessToken: encrypt(tokens.token),
    accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    isActive: true,
    lastError: null,
  };
  const conn = await prisma.channelConnection.upsert({
    where: { channelId_propertyId: { channelId: channel.id, propertyId } },
    create: { channelId: channel.id, propertyId, ...data },
    update: data,
  });

  // Ulanish o'zgardi — xona turlari keshi eskirdi (boshqa hisob bo'lishi mumkin)
  const { invalidateRoomTypes } = await import("../channel/propertyCache.js");
  invalidateRoomTypes();

  return conn;
}

/**
 * Faol ulanishni shu hisobdagi boshqa obyektga o'tkazadi (token o'sha).
 * Obyekt hisobda borligini chaqiruvchi tekshiradi (adapter).
 */
export async function switchProperty(propertyId: string): Promise<void> {
  const conn = await activeConnection();
  if (!conn) throw new Beds24AuthError("Beds24 ulanmagan", false);
  if (conn.propertyId === propertyId) return;
  // Shu obyektning eski (nofaol) yozuvi — unique(channelId, propertyId) ga urilmasin
  await prisma.channelConnection.deleteMany({
    where: { channelId: conn.channelId, propertyId, NOT: { id: conn.id } },
  });
  await prisma.channelConnection.update({
    where: { id: conn.id },
    data: { propertyId, lastCheckedAt: null, lastCheckOk: null, lastError: null },
  });
  const { invalidateRoomTypes } = await import("../channel/propertyCache.js");
  invalidateRoomTypes();
}

/** Ulanishni o'chirish — tokenlar bazadan o'chiriladi */
export async function disconnect(): Promise<number> {
  const r = await prisma.channelConnection.updateMany({
    where: { channel: { code: "beds24" }, isActive: true },
    data: { isActive: false, accessToken: null, accessTokenExpiresAt: null, refreshToken: "" },
  });
  const { invalidateRoomTypes } = await import("../channel/propertyCache.js");
  invalidateRoomTypes();
  return r.count;
}

// ============================================================
//  Access token
// ============================================================

/**
 * Jarayon ichidagi yagona yangilash.
 *
 * Refresh token almashadigan bo'lgani uchun ikki parallel yangilash
 * xavfli: birinchisi tokenni almashtiradi, ikkinchisi eski (endi
 * o'lik) token bilan boradi va butun ulanishni to'xtatadi.
 */
let refreshing: Promise<string> | null = null;

async function refreshAccessToken(connId: string, encryptedRefresh: string): Promise<string> {
  try {
    const body = await requestToken(decrypt(encryptedRefresh));

    await prisma.channelConnection.update({
      where: { id: connId },
      data: {
        accessToken: encrypt(body.token),
        accessTokenExpiresAt: new Date(Date.now() + body.expiresIn * 1000),
        // Yangi refresh token keldi — eskisi o'ldi, darhol saqlaymiz
        ...(body.refreshToken ? { refreshToken: encrypt(body.refreshToken) } : {}),
      },
    });

    if (config.isDev) {
      console.log(
        `[beds24] token yangilandi, ${Math.round(body.expiresIn / 3600)} soat amal qiladi` +
        (body.refreshToken ? " (refresh token almashdi va saqlandi)" : "")
      );
    }
    return body.token;
  } catch (e) {
    // Boshqa JARAYON tokenni bizdan oldin almashtirgan bo'lishi mumkin —
    // DB'dagi yangisini tekshiramiz
    if (e instanceof Beds24AuthError && !e.retryable) {
      const fresh = await prisma.channelConnection.findUnique({ where: { id: connId } });
      if (fresh && fresh.refreshToken && fresh.refreshToken !== encryptedRefresh) {
        const exp = fresh.accessTokenExpiresAt?.getTime() ?? 0;
        if (fresh.accessToken && exp - Date.now() > REFRESH_MARGIN_MS) return decrypt(fresh.accessToken);
        return refreshAccessToken(connId, fresh.refreshToken);
      }
      await prisma.channelConnection.update({
        where: { id: connId },
        data: { lastCheckOk: false, lastError: e.message.slice(0, 300), lastCheckedAt: new Date() },
      }).catch(() => {});
    }
    throw e;
  }
}

/**
 * Yaroqli access token qaytaradi.
 *
 * Keshdagi token hali amal qilsa — o'shani beradi (kredit sarflanmaydi).
 * Muddati tugagan yoki tugashiga yaqin bo'lsa — refresh token bilan
 * yangilaydi va DB'ga yozadi.
 */
export async function getAccessToken(): Promise<string> {
  const conn = await activeConnection();
  if (!conn || !conn.refreshToken) {
    throw new Beds24AuthError("Beds24 ulanmagan — admin panel -> Channel manager -> Ulash", false);
  }

  const expiresAt = conn.accessTokenExpiresAt?.getTime() ?? 0;
  if (conn.accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decrypt(conn.accessToken);
  }

  if (!refreshing) {
    refreshing = refreshAccessToken(conn.id, conn.refreshToken).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Keshni majburan bekor qilish — 401 kelganda */
export async function invalidateToken(): Promise<void> {
  await prisma.channelConnection.updateMany({
    where: { channel: { code: "beds24" }, isActive: true },
    data: { accessToken: null, accessTokenExpiresAt: null },
  });
}

/** "Ulanishni tekshirish" natijasini yozadi */
export async function recordCheck(ok: boolean, error?: string | null, scopes?: string[]): Promise<void> {
  const conn = await activeConnection();
  if (!conn) return;
  await prisma.channelConnection.update({
    where: { id: conn.id },
    data: {
      lastCheckedAt: new Date(),
      lastCheckOk: ok,
      lastError: ok ? null : (error ?? "").slice(0, 300),
      ...(scopes ? { scopes } : {}),
    },
  });
}

/** Ulanish holati — admin panel uchun (TZ 13-band: token chiqmaydi) */
export async function getConnectionStatus() {
  const conn = await activeConnection();
  return {
    isConnected: conn !== null,
    propertyId: conn?.propertyId ?? null,
    tokenExpiresAt: conn?.accessTokenExpiresAt?.toISOString() ?? null,
    lastCheckedAt: conn?.lastCheckedAt?.toISOString() ?? null,
    lastCheckOk: conn?.lastCheckOk ?? null,
    lastError: conn?.lastError ?? null,
    scopes: (conn?.scopes as string[] | null) ?? [],
    connectedAt: conn?.createdAt.toISOString() ?? null,
    encryptionKeySet: hasEncryptionKey(),
  };
}
