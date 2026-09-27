/**
 * ChannelAdapter interfeysi — TZ 12-band
 *
 * Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §4
 *
 * TZ: "Arxitektura faqat Beds24 bilan cheklanmasin... Bronevik,
 * MyBooking kabi kanallarni qo'shish mumkin bo'ladigan qilib yozilsin."
 *
 * Bu fayl — CHEGARA. Biznes-mantiq qatlami faqat shu interfeysni
 * biladi, "Beds24" nomini hech qayerda qattiq yozmaydi.
 *
 * Kelajakda `BronevikAdapter` qo'shilsa — sync queue, mapping va
 * status-mapping mantig'i qayta yozilmaydi, faqat yangi adapter
 * ulanadi.
 */

// --- Tashqi kanaldan keladigan bron (TZ 1-band maydonlari) --
export type ExternalReservation = {
  externalId: string;
  externalRoomTypeId: string;
  externalUnitId?: string;
  status: string;                  // kanal o'z atamasi — statusMap tarjima qiladi
  subStatus?: string;
  checkIn: string;                 // "YYYY-MM-DD"
  checkOut: string;
  adults: number;
  children: number;
  price: number;
  currency: string;
  guest: {
    fullName: string;
    phone?: string;
    email?: string;
    country?: string;
    address?: string;
  };
  notes?: string;
  /** Mehmonga ko'rinadigan nom: "Booking.com", "Airbnb", "Direct" */
  source?: string;
  /**
   * Kanal kodi — Beds24 `channel` maydoni: "booking", "expedia",
   * "airbnb", "ostrovok", "direct". Manbani aniqlashning ishonchli
   * yo'li (`referer` erkin matn, "Agent_200" kabi bo'lishi mumkin).
   */
  channelCode?: string;
  /** OTA'dagi bron raqami (Booking.com'da mehmon ko'radigan raqam) */
  externalReference?: string;
  /** Beds24 bayroq matni — check-in/out belgisi shu yerda yuradi */
  flagText?: string;
  payments?: Array<{ amount: number; description?: string; externalId?: string }>;
  modifiedAt: string;              // ISO — polling filtri uchun
  /** Bizning o'z aks-sadomizmi (04-fayl §6 echo loop himoyasi) */
  isOwnEcho?: boolean;
};

/**
 * Tashqi yozuv turi — hamma "bron" ham mehmon broni emas.
 *
 *   reservation — mehmon broni, PMS'da `Reservation` bo'ladi
 *   block       — xona yopilgan (Beds24 `black`): ta'mir, egasi uchun
 *   inquiry     — so'rov, xonani band qilmaydi
 */
export type ExternalKind = "reservation" | "block" | "inquiry";

// --- Kanaldagi room type (mapping ekrani uchun) -------------
export type ExternalRoomType = {
  id: string;
  name: string;
  /** Shu turdagi xonalar soni — agregatsiya tekshiruvi uchun (07-fayl §2) */
  qty: number;
  maxPeople?: number;
  /** Unit-level mapping mavjudmi (06-fayl §2, Daraja 2) */
  units: Array<{ id: string; name: string }>;
};

export type ExternalProperty = {
  id: string;
  name: string;
  currency: string;
  roomTypes: ExternalRoomType[];
};

// --- Sync natijasi ------------------------------------------
export type SyncResult =
  | { ok: true; externalId?: string; detail?: string }
  | { ok: false; error: string; retryable: boolean; retryAfterSeconds?: number };

export type WebhookResult = {
  event: string;
  externalId: string | null;
  reservation?: ExternalReservation;
  /** Bizning aks-sadomiz — e'tiborsiz qoldiriladi */
  isOwnEcho: boolean;
};

// --- Availability / rates yuborish payload'i ----------------
export type AvailabilityPush = {
  externalRoomTypeId: string;
  days: Array<{ date: string; available: number }>;
};

export type RatesPush = {
  externalRoomTypeId: string;
  days: Array<{ date: string; price: number; minStay?: number }>;
};

/** Kanaldagi narx — `pullRates` (Beds24 -> PMS) uchun */
export type ExternalRateDay = {
  externalRoomTypeId: string;
  date: string;
  price?: number;
  minStay?: number;
};

/**
 * Bronni kanalga yuborish rejimi.
 *
 *   full — bron PMS'da tug'ilgan (sayt, qabulxona): hamma maydon
 *          yuboriladi
 *   ota  — bron OTA'dan kelgan (Booking.com va h.k.): kanal egasi
 *          OTA, shuning uchun narx, sana, mehmon, status va `referer`
 *          YUBORILMAYDI. Faqat xona/unit va check-in/out belgisi.
 *          Aks holda Beds24'dagi OTA broni buziladi va OTA'dan
 *          kelgan keyingi bekor qilish "o'z aks-sadomiz" deb
 *          tashlab yuboriladi.
 */
export type PushMode = "full" | "ota";

/**
 * Kanal adapteri.
 *
 * `MockAdapter` va `Beds24Adapter` — ikkalasi ham shu interfeysni
 * bajaradi. Test mock bilan, production haqiqiy kanal bilan ishlaydi,
 * kod bir xil.
 */
export interface ChannelAdapter {
  /** Kanal kodi — `Channel.code` bilan mos (`"beds24"`) */
  readonly code: string;

  /** Ulanish tekshiruvi. FAZA 15 `beds24:verify` shuni chaqiradi */
  ping(): Promise<{ ok: boolean; detail: string; creditsRemaining?: number }>;

  /** Room type ro'yxati — mapping ekrani uchun (06-fayl §3) */
  getRoomTypes(): Promise<ExternalProperty[]>;

  /** O'zgargan bronlarni tortish — polling fallback (04-fayl §8) */
  pullReservations(since: Date): Promise<ExternalReservation[]>;

  /**
   * Hozirgi va kelgusi HAMMA bronlar (chiqish sanasi `departureFrom`
   * dan keyin) — birinchi ulanishda to'liq import uchun.
   *
   * 2026-09-27: ilgari birinchi polling faqat oxirgi 24 soatda
   * o'zgarganlarni olardi — ulanishdan oldin kelgan OTA bronlari PMS'ga
   * hech qachon tushmasdi (sayt o'sha kunlarni sotishi mumkin edi).
   */
  pullActiveReservations(departureFrom: string): Promise<ExternalReservation[]>;

  /** Token ruxsatlari (scope) — "Ulanishni tekshirish" ko'rsatadi */
  getTokenScopes(): Promise<string[]>;

  /** Bronni kanalga yuborish (TZ 2-band, 12-fayl §3) */
  pushReservation(payload: {
    externalId?: string;
    externalRoomTypeId: string;
    externalUnitId?: string;
    status: string;
    subStatus?: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    /**
     * Kanal valyutasida. Berilmasa narx yuborilmaydi — PMS va kanal
     * valyutasi mos kelmaganda so'm raqami dollar bo'lib ketmasin.
     */
    totalPrice?: number;
    guestFirstName: string;
    guestLastName: string;
    phone?: string;
    email?: string;
    notes?: string;
    /** Check-in/out belgisi (Beds24'da bunday status yo'q) */
    flagText?: string;
    flagColor?: string;
    /** Standart `full`. Mavjud bronni yangilashda adapter o'zi ham aniqlaydi */
    mode?: PushMode;
  }): Promise<SyncResult>;

  /**
   * Xona yopilishini kanalga yuborish (2026-09-25, B2).
   *
   * Beds24'da xona yopish — `status: "black"` bron. `cancel: true` —
   * mavjud yopishni bekor qilish (xona yana sotuvga chiqadi).
   * `checkOut` — oxirgi yopiq kundan keyingi kun (`[)` oraliq).
   */
  pushBlock(payload: {
    externalId?: string;
    externalRoomTypeId: string;
    externalUnitId?: string;
    checkIn: string;
    checkOut: string;
    note?: string;
    cancel?: boolean;
  }): Promise<SyncResult>;

  /** Availability yuborish (TZ 6-band, 07-fayl §4) */
  pushAvailability(payload: AvailabilityPush): Promise<SyncResult>;

  /** Narx yuborish (TZ 7-band) */
  pushRates(payload: RatesPush): Promise<SyncResult>;

  /** Joriy availability'ni o'qish — drift tekshiruvi (07-fayl §6) */
  getAvailability(
    externalRoomTypeId: string,
    from: string,
    to: string
  ): Promise<Array<{ date: string; available: number; price?: number }>>;

  /**
   * Barcha xonalar narxini o'qish — Beds24 -> PMS (`pullRates`).
   *
   * Kanal narx o'zgarishi haqida webhook yubormaydi, shuning uchun
   * narx davriy tortib olinadi. `to` kiradi.
   */
  getRates(from: string, to: string): Promise<ExternalRateDay[]>;

  /** Kanaldagi obyekt valyutasi — narx yuborishdan oldin tekshiruv */
  getCurrency(): Promise<string>;

  /** Kiruvchi webhook'ni normallashtirish (04-fayl) */
  parseWebhook(payload: unknown): WebhookResult;
}
