/**
 * Beds24 o'qish funksiyalari — javobni PMS tushunadigan shaklga keltiradi.
 *
 * Maydonlar va xulq real hisobda tekshirilgan (BEDS24.md, "Real API
 * faktlari" va "Maydonlar xaritasi"):
 *   - `/properties` xona turlarini faqat `includeAllRooms=true` bilan beradi
 *   - `/bookings` status berilmasa bekor qilinganlarni bermaydi — hamma
 *     statuslar aniq so'raladi; javob sahifalanadi
 *   - `/inventory/rooms/calendar` `include*` bayroqlarisiz bo'sh keladi,
 *     kunlar oraliqqa siqilgan (`from`..`to`)
 *   - unit id har xona turida 1 dan boshlanadi — faqat roomId bilan noyob
 */

import { beds24Get } from "./client.js";

export type ExternalUnit = { id: string; name: string };
export type ExternalRoomType = { id: string; name: string; qty: number; maxPeople: number | null; units: ExternalUnit[] };
export type ExternalProperty = { id: string; name: string; currency: string; roomTypes: ExternalRoomType[] };

type RawProperty = {
  id: number;
  name?: string;
  currency?: string;
  roomTypes?: Array<{
    id: number;
    name?: string;
    qty?: number;
    maxPeople?: number;
    units?: Array<{ id: number; name?: string }>;
  }>;
};

export async function getProperties(): Promise<ExternalProperty[]> {
  const res = await beds24Get<{ data?: RawProperty[] }>("/properties", { includeAllRooms: true });
  return (res.data ?? []).map((p) => ({
    id: String(p.id),
    name: p.name || `Obyekt ${p.id}`,
    currency: (p.currency || "USD").toUpperCase(),
    roomTypes: (p.roomTypes ?? []).map((rt) => ({
      id: String(rt.id),
      name: rt.name || `Xona turi ${rt.id}`,
      qty: rt.qty ?? (rt.units?.length ?? 0),
      maxPeople: rt.maxPeople ?? null,
      units: (rt.units ?? []).map((u) => ({ id: String(u.id), name: (u.name ?? String(u.id)).trim() })),
    })),
  }));
}

// ============================================================
//  Bronlar
// ============================================================

export type RawBooking = {
  id: number;
  propertyId?: number;
  roomId: number;
  unitId?: number;
  status: string;
  subStatus?: string;
  arrival: string;
  departure: string;
  numAdult?: number;
  numChild?: number;
  price?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  country?: string;
  country2?: string;
  referer?: string;
  channel?: string;
  apiSource?: string;
  apiReference?: string;
  notes?: string;
  comments?: string;
  bookingTime?: string;
  modifiedTime?: string;
};

export type ExternalBooking = {
  externalId: string;
  externalRoomTypeId: string;
  externalUnitId: string | null;
  status: string;
  subStatus: string | null;
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  price: number;
  guestName: string;
  phone: string | null;
  email: string | null;
  country: string | null;
  source: string | null;
  apiReference: string | null;
  notes: string | null;
  bookedAt: Date | null;
  modifiedAt: Date | null;
};

const ALL_STATUSES = ["confirmed", "request", "new", "cancelled", "black", "inquiry"];

function parseTime(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Manba nomi: "Booking.com", "Airbnb", "direct" */
function sourceOf(b: RawBooking): string | null {
  return (b.apiSource || b.channel || b.referer || "").trim() || null;
}

export function normalizeBooking(b: RawBooking): ExternalBooking {
  const name = [b.firstName, b.lastName].filter(Boolean).join(" ").trim();
  const notes = [b.notes, b.comments].filter((x) => x && x.trim()).join("\n").trim();
  return {
    externalId: String(b.id),
    externalRoomTypeId: String(b.roomId),
    externalUnitId: b.unitId ? String(b.unitId) : null,
    status: String(b.status || "").toLowerCase(),
    subStatus: b.subStatus ? String(b.subStatus) : null,
    arrival: String(b.arrival).slice(0, 10),
    departure: String(b.departure).slice(0, 10),
    numAdult: Number(b.numAdult ?? 1) || 1,
    numChild: Number(b.numChild ?? 0) || 0,
    price: Number(b.price ?? 0) || 0,
    guestName: name || "Noma'lum mehmon",
    phone: (b.phone || b.mobile || "").trim() || null,
    email: (b.email || "").trim() || null,
    country: (b.country2 || b.country || "").trim() || null,
    source: sourceOf(b),
    apiReference: (b.apiReference || "").trim() || null,
    notes: notes ? notes.slice(0, 2000) : null,
    bookedAt: parseTime(b.bookingTime),
    modifiedAt: parseTime(b.modifiedTime),
  };
}

/**
 * Hozirgi va kelajakdagi bronlar (hamma statuslar, hamma sahifalar).
 *
 * `departureFrom = bugun`: xonada turgan mehmon ham kiradi, o'tib
 * ketganlar kirmaydi (ular solishtirishga kerak emas).
 */
export async function getBookings(propertyId: string, departureFrom: string): Promise<ExternalBooking[]> {
  const out: ExternalBooking[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await beds24Get<{ data?: RawBooking[]; pages?: { nextPageExists?: boolean } }>("/bookings", {
      propertyId,
      departureFrom,
      status: ALL_STATUSES,
      page,
    });
    for (const b of res.data ?? []) out.push(normalizeBooking(b));
    if (!res.pages?.nextPageExists) break;
  }
  return out;
}

// ============================================================
//  Kalendar (bo'sh joy, narx)
// ============================================================

export type CalendarDay = {
  externalRoomTypeId: string;
  date: string;
  numAvail: number | null;
  price1: number | null;
  minStay: number | null;
};

type RawCalendar = {
  data?: Array<{
    roomId: number;
    calendar?: Array<{ from: string; to?: string; numAvail?: number; price1?: number; minStay?: number }>;
  }>;
};

function* daysBetween(from: string, to: string): Generator<string> {
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (let i = 0; d <= end && i < 800; i++) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Obyektning hamma xonalari, `[startDate, endDate]` — oraliqlar kunlarga yoyiladi */
export async function getCalendar(propertyId: string, startDate: string, endDate: string): Promise<CalendarDay[]> {
  const res = await beds24Get<RawCalendar>("/inventory/rooms/calendar", {
    propertyId,
    startDate,
    endDate,
    includeNumAvail: true,
    includePrices: true,
    includeMinStay: true,
  });

  const out: CalendarDay[] = [];
  for (const room of res.data ?? []) {
    for (const c of room.calendar ?? []) {
      for (const date of daysBetween(c.from, c.to ?? c.from)) {
        if (date < startDate || date > endDate) continue;
        out.push({
          externalRoomTypeId: String(room.roomId),
          date,
          numAvail: c.numAvail ?? null,
          price1: c.price1 ?? null,
          minStay: c.minStay ?? null,
        });
      }
    }
  }
  return out;
}

/** Token ruxsatlari — "Ulanishni tekshirish" ko'rsatadi */
export async function getTokenDetails(): Promise<{ valid: boolean; scopes: string[]; expiresIn: number | null }> {
  const res = await beds24Get<{ validToken?: boolean; token?: { scopes?: string[]; expiresIn?: number } }>(
    "/authentication/details"
  );
  return {
    valid: res.validToken !== false,
    scopes: res.token?.scopes ?? [],
    expiresIn: res.token?.expiresIn ?? null,
  };
}
