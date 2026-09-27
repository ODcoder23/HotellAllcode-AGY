/**
 * Beds24Adapter — ChannelAdapter implementatsiyasi
 *
 * Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §4, 03-fayl §2
 *
 * Bu fayl Beds24'ning o'z formatini bizning umumiy shaklga tarjima
 * qiladi. Biznes-mantiq qatlami faqat `ChannelAdapter` ni biladi,
 * Beds24 tafsilotlarini ko'rmaydi.
 *
 * REAL API BILAN SOLISHTIRILDI (2026-09-25, faqat GET so'rovlar,
 * batafsil: BEDS24.md). Mock asosida yozilgan kodda topilgan va shu
 * faylda tuzatilgan farqlar:
 *
 *   - `/properties` xona turlarini faqat `includeAllRooms=true` bilan
 *     beradi — ilgari mapping sahifasi bo'sh qolardi.
 *   - `/bookings` status berilmasa BEKOR QILINGANLARNI QAYTARMAYDI —
 *     polling bekor qilishni ko'rmasdi. Javob sahifalanadi.
 *   - Kalendar `include*` bayroqlarisiz bo'sh keladi va kunlarni
 *     oraliqqa (`from`–`to`) siqadi — ilgari drift tekshiruvi hech
 *     narsa ko'rmasdi.
 *   - Valyuta obyekt darajasida (real hisobda USD) — ilgari "USD"
 *     qattiq yozilgan edi.
 *   - Webhook: `{timeStamp, booking, invoiceItems, infoItems,
 *     messages, retries}`. `event` yo'q, to'lovlar bron ICHIDA emas.
 *   - Mavjud OTA bronini yangilaganda `referer: "PMS"` va narx yozib
 *     yuborilardi: Beds24'dagi Booking.com broni buzilar, keyingi
 *     haqiqiy bekor qilish esa "o'z aks-sadomiz" deb tashlanardi.
 *
 * 2026-09-27 (qaytarilganda): hamma o'qish faqat ULANGAN obyekt bo'yicha
 * (`propertyId`) — hisobda bir necha obyekt bo'lsa boshqasining bronlari
 * va xonalari aralashmasin.
 */

import { prisma } from "../../lib/prisma.js";
import { UNKNOWN_GUEST } from "../channel/types.js";
import type {
  ChannelAdapter,
  ExternalProperty,
  ExternalRateDay,
  ExternalReservation,
  ExternalRoomType,
  AvailabilityPush,
  PushMode,
  RatesPush,
  SyncResult,
  WebhookResult,
} from "../channel/types.js";
import { beds24Request, getCreditState, RateLimitError, Beds24ApiError } from "./client.js";
import { Beds24AuthError } from "./auth.js";

// --- Beds24 javob shakllari ---------------------------------

type Beds24InvoiceItem = {
  id?: number;
  type: string;
  amount: number;
  qty?: number;
  lineTotal?: number;
  description?: string;
};

type Beds24Booking = {
  id: number;
  propertyId?: number;
  roomId: number;
  unitId?: number;
  status: string;
  subStatus?: string;
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  price: number;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  country?: string;
  /** ISO kod ("UZ") — `country` ko'pincha bo'sh keladi */
  country2?: string | null;
  address?: string;
  notes?: string;
  comments?: string;
  /** OTA'ning mehmon xabari (Booking.com: maxsus iltimoslar, to'lov turi) */
  apiMessage?: string;
  /** Mehmon aytgan kelish vaqti ("14:00") */
  arrivalTime?: string;
  flagText?: string;
  referer?: string;
  channel?: string;
  apiSource?: string;
  apiReference?: string;
  modifiedTime: string;
  invoiceItems?: Beds24InvoiceItem[];
};

type Beds24Property = {
  id: number;
  name: string;
  currency?: string;
  roomTypes?: Array<{
    id: number;
    name: string;
    qty: number;
    maxPeople?: number;
    units?: Array<{ id: number; name: string }>;
  }>;
};

type Beds24List<T> = {
  success?: boolean;
  data?: T[];
  pages?: { nextPageExists?: boolean; nextPageLink?: string | null };
};

type CalendarRow = {
  roomId: number;
  calendar: Array<{ from: string; to?: string; numAvail?: number; price1?: number; minStay?: number }>;
};

type PostResult = {
  success?: boolean;
  new?: { id?: number };
  modified?: { id?: number };
  errors?: Array<{ field?: string; message?: string }>;
  warnings?: Array<{ field?: string; message?: string }>;
};

/** Biz yaratgan bron belgisi — faqat YARATISHDA yoziladi */
const OWN_REFERER = "PMS";

/** Polling bekor qilishni ham ko'rishi uchun — barcha statuslar */
const ALL_STATUSES = ["confirmed", "request", "new", "cancelled", "black", "inquiry"];

/** Sahifalash chegarasi — cheksiz halqadan himoya */
const MAX_PAGES = 20;

/** Kanal kodi -> odam o'qiydigan nom (`apiSource` bo'sh bo'lsa) */
const CHANNEL_NAMES: Record<string, string> = {
  booking: "Booking.com",
  expedia: "Expedia",
  airbnb: "Airbnb",
  ostrovok: "Ostrovok (ETG)",
  ostrovokru: "Ostrovok (ETG)",
  direct: "Direct",
};

function sourceName(b: Beds24Booking): string | undefined {
  const code = (b.channel ?? "").toLowerCase();
  return b.apiSource || CHANNEL_NAMES[code] || b.referer || undefined;
}

/**
 * Bron izohi: xodim izohi, mehmon izohi, kelish vaqti va OTA xabari.
 *
 * `apiMessage` (2026-09-26, real hisob o'qildi): Booking.com bronida
 * mehmonning maxsus iltimoslari va to'lov turi shu yerda keladi —
 * ilgari olinmasdi. Takror qo'shilmaydi: izoh PMS'dan Beds24'ga
 * qaytib yozilsa (to'g'ridan-to'g'ri bron), keyingi o'qishda o'sha
 * qism allaqachon bor — matn har aylanishda o'smasin.
 */
export function bookingNotes(b: Pick<Beds24Booking, "notes" | "comments" | "arrivalTime" | "apiMessage">): string | undefined {
  const parts = [
    b.notes,
    b.comments,
    b.arrivalTime?.trim() ? `Kelish vaqti: ${b.arrivalTime.trim()}` : undefined,
    b.apiMessage?.trim() ? b.apiMessage.trim().slice(0, 1000) : undefined,
  ];
  let out = "";
  for (const p of parts) {
    const t = p?.trim();
    if (!t || out.includes(t)) continue;
    out = out ? `${out}\n${t}` : t;
  }
  return out || undefined;
}

function toExternalReservation(
  b: Beds24Booking,
  opts: { currency: string; invoiceItems?: Beds24InvoiceItem[] }
): ExternalReservation {
  // Bir so'zli ism Beds24'ga "Ali" + "." bo'lib ketadi (`splitName`) —
  // qaytib kelganda nuqta ism ichiga qo'shilmasin (mehmon yangilanadi)
  const fullName = [b.firstName, b.lastName]
    .map((s) => s?.trim())
    .filter((s) => s && s !== ".")
    .join(" ");
  const items = opts.invoiceItems ?? b.invoiceItems ?? [];
  const notes = bookingNotes(b);

  return {
    externalId: String(b.id),
    externalRoomTypeId: String(b.roomId),
    externalUnitId: b.unitId ? String(b.unitId) : undefined,
    status: b.status,
    subStatus: b.subStatus,
    checkIn: b.arrival,
    checkOut: b.departure,
    adults: b.numAdult ?? 1,
    children: b.numChild ?? 0,
    price: b.price ?? 0,
    currency: opts.currency,
    guest: {
      fullName: fullName || UNKNOWN_GUEST,
      phone: b.phone || b.mobile || undefined,
      email: b.email || undefined,
      country: b.country2 || b.country || undefined,
      address: b.address || undefined,
    },
    notes,
    source: sourceName(b),
    channelCode: b.channel || undefined,
    externalReference: b.apiReference || undefined,
    flagText: b.flagText || undefined,
    payments: items
      .filter((i) => i.type === "payment")
      .map((i) => ({
        amount: i.lineTotal ?? i.amount * (i.qty ?? 1),
        description: i.description,
        externalId: i.id !== undefined ? `b24item:${i.id}` : undefined,
      })),
    modifiedAt: b.modifiedTime,
    isOwnEcho: b.referer === OWN_REFERER,
  };
}

function toExternalRoomType(rt: NonNullable<Beds24Property["roomTypes"]>[number]): ExternalRoomType {
  return {
    id: String(rt.id),
    name: rt.name,
    qty: rt.qty,
    maxPeople: rt.maxPeople,
    units: (rt.units ?? []).map((u) => ({ id: String(u.id), name: u.name })),
  };
}

/** Kalendar oralig'ini kunlarga yoyadi, so'ralgan chegaradan chiqmaydi */
function expandRange(from: string, to: string | undefined, min: string, max: string): string[] {
  const out: string[] = [];
  const start = from < min ? min : from;
  const end = (to ?? from) > max ? max : (to ?? from);
  const d = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Xatoni SyncResult ga aylantiradi — worker shu shaklni kutadi */
function toSyncFailure(e: unknown): SyncResult {
  if (e instanceof RateLimitError) {
    return { ok: false, error: e.message, retryable: true, retryAfterSeconds: e.retryAfterSeconds };
  }
  if (e instanceof Beds24ApiError) {
    return { ok: false, error: e.message, retryable: e.retryable };
  }
  if (e instanceof Beds24AuthError) {
    return { ok: false, error: e.message, retryable: e.retryable };
  }
  return { ok: false, error: String(e).slice(0, 200), retryable: false };
}

/** POST javobidagi xato — validatsiya yoki "joy yo'q" (qayta yuborish foydasiz) */
function postFailure(r: PostResult | undefined): SyncResult | null {
  if (!r) return { ok: false, error: "Beds24 bo'sh javob qaytardi", retryable: true };
  if (r.success === false || (r.errors && r.errors.length > 0)) {
    const text = (r.errors ?? []).map((e) => `${e.field ?? "?"}: ${e.message ?? "?"}`).join("; ");
    const noRoom = /availab/i.test(text);
    return {
      ok: false,
      error: noRoom
        ? `Beds24 rad etdi: bu sanalarda joy yo'q (${text}). Beds24 ustuvor — bronni boshqa xona/sanaga o'tkazing yoki bekor qiling.`
        : text || "Beds24 so'rovni qabul qilmadi",
      retryable: false,
    };
  }
  return null;
}

/** Ulangan obyekt ID — hamma o'qish shu bilan cheklanadi */
async function connectedPropertyId(): Promise<string | undefined> {
  const conn = await prisma.channelConnection.findFirst({
    where: { channel: { code: "beds24" }, isActive: true },
    orderBy: { updatedAt: "desc" },
    select: { propertyId: true },
  });
  return conn?.propertyId;
}

// ============================================================

export class Beds24Adapter implements ChannelAdapter {
  readonly code = "beds24";

  /** Obyekt valyutasi keshi — kamdan-kam o'zgaradi */
  private currencyCache: { value: string; at: number; propertyId?: string } | null = null;

  async ping() {
    try {
      const props = await this.getRoomTypes();
      const c = getCreditState();
      const p = props[0];
      return {
        ok: true,
        detail: p
          ? `Ulanish ishlaydi: ${p.name} (${p.currency || "valyuta ?"}), ${p.roomTypes.length} xona turi. Kredit qoldi: ${c.remaining ?? "?"}`
          : "Ulanish ishlaydi, lekin obyekt topilmadi",
        creditsRemaining: c.remaining ?? undefined,
      };
    } catch (e) {
      return { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 200) };
    }
  }

  async getTokenScopes(): Promise<string[]> {
    const res = await beds24Request<{ validToken?: boolean; token?: { scopes?: string[] } }>(
      "/authentication/details"
    );
    return res.token?.scopes ?? [];
  }

  async getRoomTypes(): Promise<ExternalProperty[]> {
    const propertyId = await connectedPropertyId();
    const res = await beds24Request<Beds24List<Beds24Property>>("/properties", {
      query: { includeAllRooms: true },
      estimatedCost: 2,
    });

    const all = (res.data ?? []).map((p) => ({
      id: String(p.id),
      name: p.name || `Obyekt ${p.id}`,
      currency: (p.currency ?? "").toUpperCase(),
      roomTypes: (p.roomTypes ?? []).map(toExternalRoomType),
    }));
    // Faqat ulangan obyekt: boshqa obyektga jimgina o'tib ketmaslik
    const props = propertyId ? all.filter((p) => p.id === propertyId) : all;

    if (props[0]?.currency) {
      this.currencyCache = { value: props[0].currency, at: Date.now(), propertyId: props[0].id };
    }
    return props;
  }

  async getCurrency(): Promise<string> {
    const propertyId = await connectedPropertyId();
    if (
      this.currencyCache && this.currencyCache.propertyId === propertyId &&
      Date.now() - this.currencyCache.at < 10 * 60_000
    ) {
      return this.currencyCache.value;
    }
    try {
      const props = await this.getRoomTypes();
      return props[0]?.currency ?? "";
    } catch (e) {
      // Valyuta deyarli o'zgarmaydi — Beds24 vaqtincha javob bermasa
      // eskirgan kesh bilan davom etamiz, webhook ishlovi to'xtamasin
      if (this.currencyCache?.value && this.currencyCache.propertyId === propertyId) {
        return this.currencyCache.value;
      }
      throw e;
    }
  }

  /** Bronlar ro'yxati — hamma statuslar, hamma sahifalar */
  private async listBookings(filter: Record<string, string>): Promise<ExternalReservation[]> {
    const [currency, propertyId] = await Promise.all([this.getCurrency(), connectedPropertyId()]);
    const out: ExternalReservation[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await beds24Request<Beds24List<Beds24Booking>>("/bookings", {
        query: {
          ...(propertyId ? { propertyId } : {}),
          ...filter,
          status: ALL_STATUSES,
          includeInvoiceItems: true,
          ...(page > 1 ? { page } : {}),
        },
        estimatedCost: 2,
      });
      for (const b of res.data ?? []) out.push(toExternalReservation(b, { currency }));
      if (!res.pages?.nextPageExists) break;
    }
    return out;
  }

  async pullReservations(since: Date): Promise<ExternalReservation[]> {
    return this.listBookings({ modifiedFrom: since.toISOString() });
  }

  async pullActiveReservations(departureFrom: string): Promise<ExternalReservation[]> {
    return this.listBookings({ departureFrom });
  }

  /**
   * Bron OTA'dan kelganmi — Beds24'ning o'zidan so'raladi (Q9: Beds24
   * ustuvor). PMS'dagi `source` bunga ishonchli emas: xodim bronni
   * qo'lda "Booking.com" deb yaratgan bo'lishi mumkin.
   *
   * So'rov yiqilsa `ota` qaytadi — xavfsiz tomon: ortiqcha maydon
   * yubormaslik OTA bronini buzishdan yaxshi.
   */
  private async detectMode(externalId: string): Promise<PushMode> {
    try {
      const res = await beds24Request<Beds24List<Beds24Booking>>("/bookings", {
        query: { id: externalId, status: ALL_STATUSES },
        estimatedCost: 1,
      });
      const b = res.data?.[0];
      if (!b) return "ota";
      const channel = (b.channel ?? "").toLowerCase();
      return b.referer === OWN_REFERER || channel === "" || channel === "direct" ? "full" : "ota";
    } catch {
      return "ota";
    }
  }

  async pushReservation(payload: Parameters<ChannelAdapter["pushReservation"]>[0]): Promise<SyncResult> {
    try {
      const isUpdate = Boolean(payload.externalId);
      const mode: PushMode = isUpdate
        ? (payload.mode ?? await this.detectMode(payload.externalId!))
        : "full";

      const item: Record<string, unknown> = {};
      if (isUpdate) item.id = Number(payload.externalId);

      // `roomId` + `unitId` IKKALA rejimda ham: mijoz qarori Q6 —
      // "xona almashsa Beds24 da ham ko'rinishi kerak" (12-fayl §4).
      // Faqat `id` yuborilsa Beds24 eski xonada qoldiradi.
      item.roomId = Number(payload.externalRoomTypeId);
      if (payload.externalUnitId) item.unitId = Number(payload.externalUnitId);

      if (payload.flagText !== undefined) {
        item.flagText = payload.flagText;
        item.flagColor = payload.flagColor ?? "";
      }

      if (mode === "full") {
        item.status = payload.status;
        if (payload.subStatus) item.subStatus = payload.subStatus;
        item.arrival = payload.checkIn;
        item.departure = payload.checkOut;
        item.numAdult = payload.adults;
        item.numChild = payload.children;
        item.firstName = payload.guestFirstName;
        item.lastName = payload.guestLastName;
        if (payload.totalPrice !== undefined) item.price = payload.totalPrice;
        if (payload.phone) item.phone = payload.phone;
        if (payload.email) item.email = payload.email;
        if (payload.notes) item.notes = payload.notes;
      }

      if (!isUpdate) {
        // Biz yaratgan bron belgisi — faqat yaratishda
        item.referer = OWN_REFERER;
        // Beds24 ustuvor: joy bo'lmasa bron SAQLANMAYDI va xato
        // qaytadi. Shunda sayt/qabulxona bronini boshqa kanal allaqachon
        // sotgan xonaga yozib qo'ymaymiz.
        item.actions = { checkAvailability: true };
      }

      const res = await beds24Request<PostResult[]>("/bookings", {
        method: "POST",
        body: [item],
        estimatedCost: 2,
      });

      const failure = postFailure(res[0]);
      if (failure) return failure;

      const id = res[0]?.new?.id ?? res[0]?.modified?.id;
      return {
        ok: true,
        externalId: id ? String(id) : payload.externalId,
        detail: mode === "ota" ? "OTA broni: faqat xona va belgi yuborildi" : undefined,
      };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  /**
   * Xona yopilishi -> Beds24 `black` bron (B2, 2026-09-25).
   *
   * NEGA KERAK: availability SoT = beds24 (Q9) bo'lganda PMS `numAvail`
   * yozmaydi. Ilgari PMS'da ta'mirga yopilgan xona Beds24'ga umuman
   * yetmasdi — Booking.com uni sotishda davom etardi (overbooking).
   * `black` bron aniq unitni yopadi va Beds24 bo'sh joyni o'zi kamaytiradi.
   *
   * `checkAvailability` YUBORILMAYDI: yopish joy bor-yo'qligidan qat'i
   * nazar amal qilishi kerak (PMS bron to'qnashuvini o'zi tekshiradi).
   */
  async pushBlock(payload: Parameters<ChannelAdapter["pushBlock"]>[0]): Promise<SyncResult> {
    try {
      const item: Record<string, unknown> = {};

      if (payload.cancel) {
        if (!payload.externalId) return { ok: true, detail: "Beds24'da yopish yo'q edi" };
        item.id = Number(payload.externalId);
        item.status = "cancelled";
      } else {
        if (payload.externalId) item.id = Number(payload.externalId);
        item.roomId = Number(payload.externalRoomTypeId);
        if (payload.externalUnitId) item.unitId = Number(payload.externalUnitId);
        item.status = "black";
        item.arrival = payload.checkIn;
        item.departure = payload.checkOut;
        item.numAdult = 1;
        item.firstName = "PMS";
        item.lastName = "Xona yopiq";
        if (payload.note) item.notes = payload.note.slice(0, 500);
        if (!payload.externalId) item.referer = OWN_REFERER;
      }

      const res = await beds24Request<PostResult[]>("/bookings", {
        method: "POST",
        body: [item],
        estimatedCost: 2,
      });

      const failure = postFailure(res[0]);
      if (failure) return failure;

      const id = res[0]?.new?.id ?? res[0]?.modified?.id;
      return { ok: true, externalId: id ? String(id) : payload.externalId };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  async pushAvailability(payload: AvailabilityPush): Promise<SyncResult> {
    try {
      // Ketma-ket bir xil qiymatli kunlarni oraliqqa yig'ish (07-fayl §4)
      const ranges = groupConsecutive(payload.days, (d) => d.available);

      await beds24Request("/inventory/rooms/calendar", {
        method: "POST",
        body: [{
          roomId: Number(payload.externalRoomTypeId),
          calendar: ranges.map((r) => ({
            from: r.from,
            to: r.to,
            numAvail: r.value,
          })),
        }],
        estimatedCost: 2,
      });

      return { ok: true, detail: `${payload.days.length} kun, ${ranges.length} oraliq` };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  async pushRates(payload: RatesPush): Promise<SyncResult> {
    try {
      // Narx VA minStay birga guruhlanadi — ikkalasi ham oraliqda bir xil bo'lishi kerak
      const ranges = groupConsecutive(payload.days, (d) => `${d.price}|${d.minStay ?? ""}`);

      await beds24Request("/inventory/rooms/calendar", {
        method: "POST",
        body: [{
          roomId: Number(payload.externalRoomTypeId),
          calendar: ranges.map((r) => {
            const [price, minStay] = String(r.value).split("|");
            return {
              from: r.from,
              to: r.to,
              price1: Number(price),
              ...(minStay ? { minStay: Number(minStay) } : {}),
            };
          }),
        }],
        estimatedCost: 2,
      });

      return { ok: true, detail: `${payload.days.length} kun, ${ranges.length} oraliq` };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  async getAvailability(externalRoomTypeId: string, from: string, to: string) {
    const propertyId = await connectedPropertyId();
    const res = await beds24Request<Beds24List<CalendarRow>>("/inventory/rooms/calendar", {
      query: {
        ...(propertyId ? { propertyId } : {}),
        roomId: externalRoomTypeId,
        startDate: from,
        endDate: to,
        includeNumAvail: true,
        includePrices: true,
      },
      estimatedCost: 1,
    });

    const entry = res.data?.[0];
    return (entry?.calendar ?? []).flatMap((c) =>
      expandRange(c.from, c.to, from, to).map((date) => ({
        date,
        available: c.numAvail ?? 0,
        price: c.price1,
      }))
    );
  }

  async getRates(from: string, to: string): Promise<ExternalRateDay[]> {
    // `roomId` berilmaydi — obyektning barcha xonalari bitta so'rovda
    const propertyId = await connectedPropertyId();
    const res = await beds24Request<Beds24List<CalendarRow>>("/inventory/rooms/calendar", {
      query: {
        ...(propertyId ? { propertyId } : {}),
        startDate: from, endDate: to, includePrices: true, includeMinStay: true,
      },
      estimatedCost: 2,
    });

    return (res.data ?? []).flatMap((row) =>
      (row.calendar ?? []).flatMap((c) =>
        expandRange(c.from, c.to, from, to).map((date) => ({
          externalRoomTypeId: String(row.roomId),
          date,
          price: c.price1,
          minStay: c.minStay,
        }))
      )
    );
  }

  /**
   * Webhook payload'ini o'qiydi.
   *
   * Real format (obyekt sozlamasida `version: twoWithPersonalData`):
   * `{timeStamp, booking, invoiceItems, infoItems, messages, retries}`.
   * Eski mock formati (`{event, booking}`) ham qabul qilinadi.
   *
   * `event` yo'q — nima bo'lgani bron holatidan aniqlanadi. Valyuta
   * webhook'da kelmaydi, `currency` bo'sh qoladi — `applyReservation`
   * uni kanal valyutasi bilan to'ldiradi.
   */
  parseWebhook(payload: unknown): WebhookResult {
    const p = payload as {
      event?: string;
      booking?: Beds24Booking & { bookingTime?: string };
      invoiceItems?: Beds24InvoiceItem[];
    };

    if (!p?.booking) {
      return { event: p?.event ?? "unknown", externalId: null, isOwnEcho: false };
    }

    const reservation = toExternalReservation(p.booking, {
      currency: "",
      invoiceItems: p.invoiceItems ?? p.booking.invoiceItems,
    });

    const b = p.booking;
    const event =
      p.event ??
      (b.status === "cancelled"
        ? "booking.cancelled"
        : b.bookingTime && b.bookingTime === b.modifiedTime
          ? "booking.new"
          : "booking.modified");

    return {
      event,
      externalId: reservation.externalId,
      reservation,
      isOwnEcho: reservation.isOwnEcho === true,
    };
  }
}

/**
 * Ketma-ket bir xil qiymatli kunlarni oraliqqa yig'adi.
 * 30 kunlik bir xil narx -> 1 ta oraliq (30 ta emas) = kredit tejash.
 */
function groupConsecutive<T extends { date: string }, V extends number | string>(
  days: T[],
  valueOf: (d: T) => V
): Array<{ from: string; to: string; value: V }> {
  if (days.length === 0) return [];

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const out: Array<{ from: string; to: string; value: V }> = [];

  let from = sorted[0].date;
  let to = sorted[0].date;
  let value = valueOf(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const v = valueOf(d);
    const prev = new Date(to + "T00:00:00Z");
    prev.setUTCDate(prev.getUTCDate() + 1);
    const isNextDay = prev.toISOString().slice(0, 10) === d.date;

    if (v === value && isNextDay) {
      to = d.date;
    } else {
      out.push({ from, to, value });
      from = d.date;
      to = d.date;
      value = v;
    }
  }
  out.push({ from, to, value });

  return out;
}

export const beds24Adapter = new Beds24Adapter();
