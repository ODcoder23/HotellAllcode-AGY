/**
 * Website public API — TZ 3, 20-band
 *
 * ISH CHEGARASI: Customer Website kodiga kirish yo'q.
 * Shu fayldagi API to'liq yoziladi va test qilinadi, Website'ni
 * unga ulash ishi scope'dan tashqarida — kontrakt topshiriladi.
 *
 * ASOSIY OQIM (TZ 3-band):
 *   Website -> PMS -> Database -> Shaxmatka -> Beds24 -> OTA
 * "OVERBOOKING BO'LMASLIGI SHART."
 *
 * Overbooking himoyasi shu yerda qayta yozilmaydi: bron
 * `createReservation` orqali yaratiladi, u esa `EXCLUDE USING gist`
 * constraint'i bilan himoyalangan. Sayt ham, Shaxmatka
 * ham bitta to'siqdan o'tadi.
 */

import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { fromDateKey, isValidDateKey, toDateKey, toNumber } from "../lib/serialize.js";
import { ValidationError, RoomUnavailableError } from "../lib/errors.js";
import { createReservation } from "./reservations.js";
import { readRange } from "./availability.js";
import { hotelToday } from "../lib/hotelTime.js";
import { getMealPrice, getWebsiteUnpaidCancelHours } from "./settings.js";
import {
  CURRENCY, mealTotalFor, reservationMoney, round2, stayPriceFromRates, sumMoney,
} from "../lib/money.js";

/** Sayt narxlari valyutasi — tizim valyutasi, so'm */
const SITE_CURRENCY = CURRENCY;

// ============================================================
//  1. Bron kodi
// ============================================================

/**
 * Mehmonga ko'rsatiladigan kod — "IMR-8F3K2".
 *
 * TAXMIN QILIB BO'LMAYDI: ketma-ket emas, `crypto.randomInt` bilan
 * yasaladi. Aks holda mijoz o'z kodini bir ko'targan holda boshqa
 * mehmonlarning bronini ko'ra olardi.
 *
 * Chalkashadigan belgilar (0/O, 1/I) alifbodan chiqarilgan —
 * mijoz kodni telefon orqali aytishi mumkin.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateCode(): string {
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `IMR-${out}`;
}

/** To'qnashuv bo'lsa qayta urinadi — 32^5 ≈ 33 mln variant */
async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const exists = await prisma.reservation.findUnique({ where: { code } });
    if (!exists) return code;
  }
  throw new Error("Bron kodi yaratib bo'lmadi");
}

// ============================================================
//  2. Bo'sh xonalarni qidirish
// ============================================================

export type AvailabilityQuery = {
  from: string;
  to: string;
  adults?: number;
  children?: number;
};

export type PublicRoomType = {
  id: string;
  label: string;
  availableCount: number;
  pricePerNight: number;
  /** Xona narxi x kecha (nonushtasiz) */
  roomTotal: number;
  /** Nonushta: narx x kishi x kecha */
  mealTotal: number;
  /** Kishi boshiga nonushta narxi — saytda ko'rsatish uchun */
  mealPricePerPerson: number;
  /** roomTotal + mealTotal — mehmon shuni to'laydi */
  totalPrice: number;
  currency: string;
  maxAdults: number;
};

/**
 * Sanalarni tekshiradi.
 *
 * O'tmishga bron qilib bo'lmaydi, bir yildan uzoqqa ham —
 * ikkalasi ham noto'g'ri ma'lumot yoki hujum belgisi.
 *
 * "Bugun" — mehmonxona (Toshkent) kuni. Ilgari UTC edi: Toshkentda
 * 00:00–05:00 oralig'ida sayt kechagi sanaga bron qabul qilardi.
 */
export function validateRange(fromKey: string, toKey: string): { from: Date; to: Date; nights: number } {
  const from = fromDateKey(fromKey);
  const to = fromDateKey(toKey);

  // "2026-02-31" kabi mavjud bo'lmagan sana JS'da 3-martga aylanadi
  if (!isValidDateKey(fromKey) || !isValidDateKey(toKey)) {
    throw new ValidationError("Sana formati noto'g'ri (YYYY-MM-DD)");
  }

  const today = hotelToday();

  if (from < today) throw new ValidationError("O'tmishdagi sanaga bron qilib bo'lmaydi");
  if (to <= from) throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak");

  const nights = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (nights > 365) throw new ValidationError("Maksimal muddat — 365 kecha");

  const maxAhead = new Date(today);
  maxAhead.setUTCFullYear(maxAhead.getUTCFullYear() + 1);
  if (from > maxAhead) throw new ValidationError("Bir yildan uzoqqa bron qilib bo'lmaydi");

  return { from, to, nights };
}

/**
 * Sayt "Xonalar" bo'limi uchun tarif ro'yxati.
 *
 * `searchAvailability` dan farqi: sana kerak emas. Sayt xonalarni
 * mehmon sana tanlashidan OLDIN ham ko'rsatadi, shuning uchun bu
 * yerda bandlik hisoblanmaydi — faqat tarif, narx va sig'im.
 *
 * Narx: bugundan boshlab birinchi topilgan `RatePlan` qiymati
 * ("dan boshlab" narx). Narx belgilanmagan tur ham ko'rsatiladi,
 * lekin `pricePerNight: 0` bilan — sayt uni "narx so'rang" deb
 * chiqarishi mumkin. Bu `searchAvailability` dan ataylab farq
 * qiladi: u yerda narxsiz turni sotib bo'lmaydi, bu yerda esa
 * shunchaki vitrina.
 */
export async function listRoomTypes() {
  const today = hotelToday();

  /**
   * IKKI SO'ROV, tur soniga bog'liq emas.
   *
   * Ilgari halqa ichida har tur uchun alohida `ratePlan`
   * so'rovi ketardi (N+1). 9 tur = 10 so'rov, tunnel orqali
   * ~7 soniya. Endi hamma narx bir so'rovda olinadi.
   */
  const [types, plans] = await Promise.all([
    prisma.roomType.findMany({
      where: { showOnSite: true },
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { rooms: true } } },
    }),

    // Bugundan boshlab har tur uchun eng yaqin narx
    prisma.ratePlan.findMany({
      where: { date: { gte: today } },
      orderBy: { date: "asc" },
      select: { roomTypeId: true, price: true, date: true },
    }),
  ]);

  // Har tur uchun eng birinchi (eng yaqin) narx
  const priceOf = new Map<string, number>();
  for (const p of plans) {
    if (!priceOf.has(p.roomTypeId)) {
      priceOf.set(p.roomTypeId, toNumber(p.price));
    }
  }

  return types
    // Faol xonasi yo'q tur saytda ko'rsatilmaydi
    .filter((t) => t._count.rooms > 0)
    .map((t) => ({
      id: t.id,
      label: t.label,
      pricePerNight: priceOf.get(t.id) ?? 0,
      currency: SITE_CURRENCY,
      maxAdults: t.maxAdults,
      roomCount: t._count.rooms,

      // Sayt bu maydonlarni kutadi (index.html: loadRooms)
      description: t.description ?? "",
      image: t.imageUrl ?? null,
      gallery: Array.isArray(t.gallery) ? t.gallery : [],
      amenities: Array.isArray(t.amenities) ? t.amenities : [],
    }));
}

/**
 * Oraliqdagi bo'sh xonalarni tur bo'yicha qaytaradi.
 *
 * `availableCount` — butun oraliq bo'yicha MINIMAL qiymat.
 * Agar 15-da 3 ta, 17-da 1 ta bo'sh bo'lsa, 5 kunlik
 * bron uchun javob 1 bo'ladi: mehmon bron qilmoqchi bo'lganda xato
 * chiqmasligi uchun.
 */
export async function searchAvailability(q: AvailabilityQuery) {
  const { from, to, nights } = validateRange(q.from, q.to);
  const adults = q.adults ?? 1;
  const children = q.children ?? 0;

  if (adults < 1 || adults > 20) throw new ValidationError("Kattalar soni 1–20 orasida");

  /**
   * Nonushta narxi (2026-09-17).
   *
   * Saytdan kelgan bron HAR DOIM ovqat tarifi bilan. Narx
   * qidiruv paytida qo'shiladi — mehmon to'liq summani darhol
   * ko'rsin, tasdiqlashda kutilmagan qo'shimcha chiqmasin.
   */
  const guests = adults + children;
  const mealPrice = await getMealPrice();

  const types = await prisma.roomType.findMany({ orderBy: { sortOrder: "asc" } });

  const result: PublicRoomType[] = [];

  for (const type of types) {
    // Sig'imi yetmaydigan tur ko'rsatilmaydi
    if (adults > type.maxAdults) continue;

    const days = await readRange(type.id, from, to);

    // Oraliqda hech bo'lmasa bitta kun hisoblanmagan bo'lsa —
    // uni nol deb hisoblaymiz emas, qayta hisoblash kerak.
    // Lekin `recalcAvailability` public yo'ldan chaqirilmaydi
    // (qimmat), shuning uchun yetishmagan kunlarni to'g'ridan-
    // to'g'ri bronlardan sanaymiz.
    const availableCount =
      days.length === nights
        ? Math.min(...days.map((d) => d.availableCount))
        : await countFreeRooms(type.id, from, to);

    const stay = await stayPrice(type.id, from, to, nights);

    // Narx belgilanmagan turni sotib bo'lmaydi — mijozga "0 so'm"
    // ko'rsatish va keyin haqiqiy narx aytish yomon tajriba.
    // Admin narxni Narxlar panelida belgilamaguncha tur
    // ko'rsatilmaydi (Q8).
    if (!stay || stay.roomTotal <= 0) continue;

    // Formula — lib/money.ts: bron yaratilgach bron kartasi ham
    // aynan shu summani ko'rsatadi (mehmon boshqa raqam ko'rmasin)
    const mealTotal = mealTotalFor(mealPrice, guests, nights);

    result.push({
      id: type.id,
      label: type.label,
      availableCount: Math.max(0, availableCount),
      // Kecha narxi — ko'rsatish uchun (sentgacha)
      pricePerNight: round2(stay.perNight),
      roomTotal: stay.roomTotal,
      mealTotal,
      mealPricePerPerson: round2(mealPrice),
      // Saytdan kelgan bron HAR DOIM ovqat tarifi bilan
      // (2026-09-17) — narx darhol to'liq
      // ko'rsatiladi, tasdiqlashda kutilmagan qo'shimcha
      // chiqmasin.
      totalPrice: sumMoney([stay.roomTotal, mealTotal]),
      currency: SITE_CURRENCY,
      maxAdults: type.maxAdults,
    });
  }

  return { from: q.from, to: q.to, nights, roomTypes: result };
}

/**
 * Butun oraliqda BO'SH turgan xonalar soni.
 *
 * `Availability` jadvalida kun yetishmasa ishlatiladi. Bitta SQL:
 * shu turdagi faol xonalardan oraliqqa kesishuvchi broni
 * bo'lmaganlari sanaladi.
 */
async function countFreeRooms(roomTypeId: string, from: Date, to: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ cnt: number }>>`
    SELECT COUNT(*)::int AS cnt
    FROM "Room" r
    WHERE r."roomTypeId" = ${roomTypeId}
      AND r."isActive" = true
      AND r.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      AND NOT EXISTS (
        SELECT 1 FROM "Reservation" res
        WHERE res."roomId" = r.id
          AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND res."checkIn" < ${to}
          AND res."checkOut" > ${from}
      )
      -- Ta'mir/xizmatdan chiqarilgan kunlar (2026-09-16 qo'shildi).
      -- Busiz yopiq xona saytda sotuvda qolardi: kesh yo'li buni
      -- hisobga olardi, bu zaxira yo'l esa yo'q.
      AND NOT EXISTS (
        SELECT 1 FROM "RoomDayStatus" rds
        WHERE rds."roomId" = r.id
          AND rds."isBlocked" = true
          AND rds.date >= ${from}
          AND rds.date < ${to}
      )
  `;
  return rows[0]?.cnt ?? 0;
}

/**
 * Oraliq narxi — `RatePlan` kunlaridan (lib/money.ts `stayPriceFromRates`).
 *
 * Har kecha o'z tarifi bilan qo'shiladi; qabulxonadagi "tarifdan past"
 * tekshiruvi ham aynan shu formulani ishlatadi.
 */
async function stayPrice(roomTypeId: string, from: Date, to: Date, nights: number) {
  const plans = await prisma.ratePlan.findMany({
    where: { roomTypeId, date: { gte: from, lt: to } },
    select: { price: true },
  });
  return stayPriceFromRates(plans.map((p) => p.price), nights);
}

// ============================================================
//  3. Xona avtomatik tanlash
// ============================================================

/**
 * Turdan aniq xona tanlaydi.
 *
 * Mehmon TURNI tanlaydi, tizim ANIQ XONANI biriktiradi.
 *
 * FRAGMENTATSIYA: har doim birinchi bo'sh xonani berish
 * 5 ta xonani 5 ta yarim-band xonaga aylantiradi. Shuning uchun
 * qo'shni band kunlari bor xonalar afzal — bu uzluksiz bo'shliqlarni
 * saqlaydi va uzoq bronlar uchun joy qoldiradi.
 *
 * `skip` — urinib ko'rilgan va band chiqqan xonalar (2026-09-17).
 * Parallel so'rovlar bir vaqtda kelganda hammasi bir xil xonani
 * tanlardi: eng yaxshi xona bittagina, `LIMIT 1` uni hammaga
 * berardi. Birinchisi yozib ulgurgach qolganlari "band" xatosini
 * olardi — garchi o'sha turda boshqa bo'sh xonalar turgan bo'lsa
 * ham. `createPublicBooking` band chiqqan xonani `skip` ga qo'shib
 * qayta chaqiradi, shunda navbatdagi eng yaxshi xona tanlanadi.
 */
export async function pickRoom(
  roomTypeId: string,
  from: Date,
  to: Date,
  skip: string[] = []
): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; neighbours: number }>>`
    SELECT
      r.id,
      -- Oraliqqa TEGIB turgan bronlar soni: checkOut = from yoki
      -- checkIn = to. Ular ko'p bo'lsa xona allaqachon "ishlatilgan",
      -- unga qo'shish bo'shliqni parchalamaydi.
      (
        SELECT COUNT(*)::int FROM "Reservation" res
        WHERE res."roomId" = r.id
          AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND (res."checkOut" = ${from}::date OR res."checkIn" = ${to}::date)
      ) AS neighbours
    FROM "Room" r
    WHERE r."roomTypeId" = ${roomTypeId}
      AND r."isActive" = true
      AND r.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      -- Parallel so'rovda band chiqqan xonalar (skip)
      AND NOT (r.id = ANY(${skip}::text[]))
      AND NOT EXISTS (
        SELECT 1 FROM "Reservation" res
        WHERE res."roomId" = r.id
          AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND res."checkIn" < ${to}::date
          AND res."checkOut" > ${from}::date
      )
      -- Yopiq kunlar (2026-09-16 qo'shildi): tizim ta'mirdagi
      -- xonani avtomatik tanlab qo'ymasligi uchun
      AND NOT EXISTS (
        SELECT 1 FROM "RoomDayStatus" rds
        WHERE rds."roomId" = r.id
          AND rds."isBlocked" = true
          AND rds.date >= ${from}::date
          AND rds.date < ${to}::date
      )
    ORDER BY neighbours DESC, r."sortOrder" ASC, r.id ASC
    LIMIT 1
  `;

  return rows[0]?.id ?? null;
}

// ============================================================
//  4. Bron yaratish
// ============================================================

export type PublicBookingInput = {
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  /**
   * Faqat `true` (2026-09-17): saytdan kelgan bron har doim ovqat
   * bilan. `false` ni yo'nalish (`routes/public.ts`) rad etadi.
   */
  withMeal?: true;
  guest: { fullName: string; phone: string; email?: string };
  notes?: string;
};

export type PublicBookingResult = {
  reservationCode: string;
  roomNumber: string;
  status: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** Nonushta — saytdan kelgan bronda har doim `true` */
  withMeal: boolean;
  /** Xona narxi x kecha */
  roomTotal: number;
  /** Nonushta: narx x kishi x kecha */
  mealTotal: number;
  /** roomTotal + mealTotal */
  totalPrice: number;
  currency: string;
};

/**
 * Website'dan bron yaratadi.
 *
 * STATUS `PENDING_PAYMENT`: mijoz hali to'lamagan.
 * Lekin xona SHU ZAHOTI band hisoblanadi va availability'dan
 * chiqariladi — aks holda ikki mijoz bir xonani "to'lovni
 * kutayotgan" holatda band qilib qo'yardi.
 *
 * Availability keshi `createReservation` ichida yangilanadi —
 * bu yerda qayta chaqirilmaydi.
 */
export async function createPublicBooking(
  input: PublicBookingInput
): Promise<PublicBookingResult> {
  const { from, to, nights } = validateRange(input.checkIn, input.checkOut);

  const fullName = input.guest.fullName.trim();
  if (fullName.length < 2 || fullName.length > 100) {
    throw new ValidationError("Ism 2–100 belgi orasida bo'lishi kerak");
  }

  const phone = input.guest.phone.trim();
  if (phone.length < 7 || phone.length > 20) {
    throw new ValidationError("Telefon raqami noto'g'ri");
  }

  const type = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
  if (!type) throw new ValidationError("Bunday xona turi yo'q");

  if (input.adults > type.maxAdults) {
    throw new ValidationError(`Bu turda maksimal ${type.maxAdults} kattalar`);
  }

  // Spam himoyasi: bir telefon raqamiga 3 ta faol to'lanmagan sayt broni
  await checkSpam(phone);

  const stay = await stayPrice(input.roomTypeId, from, to, nights);
  const price = stay?.perNight ?? 0;
  if (!stay || stay.roomTotal <= 0) {
    // Narxsiz bron — keyinroq mijoz bilan tortishuv chiqadi
    throw new ValidationError(
      "Bu sanalarda narx hali belgilanmagan. Iltimos, biz bilan bog'laning."
    );
  }

  const code = await uniqueCode();

  /**
   * XONA TANLASH + BRON — qayta urinish bilan (2026-09-17).
   *
   * `pickRoom` tranzaksiyadan tashqarida ishlaydi, shuning uchun
   * parallel so'rovlar bir xil xonani olishi mumkin. Ilgari
   * birinchisidan keyingilari darhol "band" xatosini olardi:
   * jonli sinovda 3 bo'sh xonaga 6 parallel so'rov yuborilganda
   * faqat BITTASI o'tdi, 5 mijoz rad javobini oldi va 2 xona
   * bo'sh qoldi. Bu overbooking emas, uning teskarisi —
   * sotilmay qolgan xona.
   *
   * Endi band chiqqan xona `taken` ga qo'shiladi va navbatdagi
   * eng yaxshi xona tanlanadi. Urinishlar soni turdagi xona
   * sonidan oshmaydi, chunki har urinishda ro'yxat qisqaradi.
   *
   * Faqat "xona band" xatolari qayta urinishga sabab bo'ladi;
   * boshqa xatolar (narx, validatsiya) darhol yuqoriga chiqadi.
   */
  const taken: string[] = [];
  const MAX_ROOM_ATTEMPTS = 10;

  let reservation: Awaited<ReturnType<typeof createReservation>> | null = null;
  let roomId = "";

  for (let attempt = 0; attempt < MAX_ROOM_ATTEMPTS; attempt++) {
    const candidate = await pickRoom(input.roomTypeId, from, to, taken);
    if (!candidate) break;          // boshqa bo'sh xona yo'q

    try {
      reservation = await createReservation({
        roomId: candidate,
        guestName: fullName,
        phone,
        email: input.guest.email?.trim(),
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.children ?? 0,
        /**
         * SAYTDAN KELGAN BRON HAR DOIM OVQAT BILAN
         * (2026-09-17).
         *
         * Ilgari `input.withMeal ?? false` edi va sayt bu
         * maydonni yubormagani uchun bron OVQATSIZ yaratilardi.
         * Natijada mehmon qidiruvda bir summa ko'rib, bron
         * qilganda boshqasini olardi:
         *
         *   qidiruv:  1 050 000 (nonushta 150 000 bilan)
         *   bron:       900 000 (nonushtasiz)
         *
         * Oshxona hisoboti ham bo'sh qolardi — `withMeal = true`
         * bronlar umuman yo'q edi.
         *
         * Qabulxona (`/api/reservations`) boshqacha: u yerda
         * tanlov bor, shuning uchun bu qoida faqat shu funksiyada.
         *
         * Nonushta narxi `createReservation` ichida sozlamadan
         * olinadi va bronga ko'chiriladi.
         */
        withMeal: true,
        code,
        source: "website",
        pricePerNight: price,
        notes: input.notes?.slice(0, 500),
        status: "pending_payment",
      });
      roomId = candidate;
      break;
    } catch (e) {
      // Xona oradagi vaqtda band bo'lib qoldi — keyingisiga
      // o'tamiz. Ikki ko'rinishi bor:
      //   `RoomUnavailableError` — `isRoomFree` tekshiruvi (2-qatlam)
      //   `23P01` — DB constraint'i (1-qatlam). Servis darajasida u
      //             hali xom Prisma xatosi: `translatePrismaError`
      //             faqat `errorHandler` ichida chaqiriladi.
      // Qolgan xatolar chaqiruvchiga qaytadi.
      // `String(e)` yetarli emas: `PrismaClientUnknownRequestError`
      // ning `toString()` faqat sinf nomini beradi, constraint nomi
      // esa `message` ichida qoladi. Ikkalasi ham qaraladi.
      const raw = `${String(e)} ${e instanceof Error ? e.message : ""}`;
      const busy =
        e instanceof RoomUnavailableError ||
        raw.includes("reservation_no_overlap") ||
        raw.includes("23P01");

      if (busy) {
        taken.push(candidate);
        continue;
      }
      throw e;
    }
  }

  if (!reservation) {
    throw new RoomUnavailableError(
      "Afsuski, tanlangan sanalarda bo'sh xona qolmadi. Boshqa sanalarni tanlang."
    );
  }

  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

  /**
   * Nonushta jami summaga kiradi.
   *
   * Summa BRONDAN hisoblanadi (lib/money.ts) — bron kartasi, "bronimni
   * tekshirish" va qidiruv natijasi bir xil raqam ko'rsatadi.
   */
  const m = reservationMoney(reservation);

  return {
    reservationCode: code,
    roomNumber: room.number,
    status: "pending_payment",
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    adults: input.adults,
    children: input.children ?? 0,
    withMeal: reservation.withMeal,
    roomTotal: m.roomTotal,
    mealTotal: m.mealTotal,
    totalPrice: m.total,
    currency: SITE_CURRENCY,
  };
}

/**
 * Bir telefon raqamiga ko'p to'lanmagan bron.
 *
 * Cheklovsiz bo'lsa bitta bot butun mehmonxonani "to'lov kutilmoqda"
 * holatida band qilib qo'yishi mumkin — real sotuv to'xtaydi.
 *
 * FAOL bronlar sanaladi — hali tugamagan, vaqt oynasisiz (2026-09-28).
 * Sayt mehmoni kelganda to'laydi va bron avtomatik bekor bo'lmaydi
 * (`WEBSITE_UNPAID_CANCEL_HOURS` = 0), shuning uchun ilgarigi "oxirgi
 * 24 soat" oynasi har kuni yana 3 ta bron qo'yishga imkon berardi.
 * Qabulxona tasdiqlagan (CONFIRMED) bron sanalmaydi.
 *
 * Raqam RAQAMLARI bo'yicha solishtiriladi (oxirgi 9 ta — O'zbekiston
 * raqami, +998 siz ham): "+998 90 111-22-33" va "+998901112233" bir raqam.
 */
async function checkSpam(phone: string): Promise<void> {
  const tail = phone.replace(/\D/g, "").slice(-9);
  if (tail.length < 7) throw new ValidationError("Telefon raqami noto'g'ri");

  const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM "Reservation" r
    JOIN "Guest" g ON g.id = r."guestId"
    WHERE r.status = 'PENDING_PAYMENT'
      AND r.source = 'WEBSITE'
      AND r."checkOut" > ${hotelToday()}
      AND right(regexp_replace(g.phone, '\\D', '', 'g'), 9) = ${tail}
  `;

  if (count >= 3) {
    throw new ValidationError(
      "Bu raqamda tasdiqlanmagan bronlar bor. Iltimos, avvalgilarini to'lang yoki biz bilan bog'laning."
    );
  }
}

// ============================================================
//  5. Bronni kod bilan tekshirish
// ============================================================

/**
 * Mijoz o'z bronini kod bilan ko'radi.
 *
 * JAVOBDA BOSHQA MEHMONLAR MA'LUMOTI YO'Q. Faqat shu
 * bronning o'zi va faqat mijozga kerakli maydonlar — ichki id,
 * telefon va to'lov tafsiloti berilmaydi.
 */
export async function findByCode(code: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: { guest: true, room: { include: { roomType: true } }, payments: true, charges: true },
  });

  if (!reservation) return null;

  /**
   * Summa — lib/money.ts (bron kartasi bilan bir xil).
   *
   * 2026-09-25 TUZATISH: ilgari bu yerda qo'shimcha xizmatlar va
   * bekor qilish jarimasi hisobga olinmasdi — mehmon "qoldiq" ni
   * qabulxonadagidan boshqacha ko'rardi.
   */
  const m = reservationMoney(reservation);
  const nights = m.nights;

  return {
    reservationCode: reservation.code,
    status: reservation.status.toLowerCase(),
    checkIn: toDateKey(reservation.checkIn),
    checkOut: toDateKey(reservation.checkOut),
    nights,
    roomNumber: reservation.room.number,
    roomType: reservation.room.roomType.label,
    adults: reservation.adults,
    children: reservation.children,
    guestName: reservation.guest.fullName,
    // Mehmon nima uchun to'laganini ko'rsin
    withMeal: reservation.withMeal,
    mealTotal: m.mealTotal,
    totalPrice: m.total,
    paidAmount: m.paid,
    remainingAmount: m.remaining,
    currency: SITE_CURRENCY,
  };
}

// ============================================================
//  6. To'lanmagan bronni avtomatik bekor qilish
// ============================================================

export type ExpireResult = {
  checked: number;
  cancelled: number;
  codes: string[];
};

/**
 * To'lanmagan sayt bronlarini muddati o'tgach bekor qiladi.
 *
 * STANDART O'CHIQ (egasi, 2026-09-28): sayt mehmoni to'lovni kelganda
 * qiladi — sayt ham shuni aytadi. Muddat biznes sozlamasida
 * (`WEBSITE_UNPAID_CANCEL_HOURS`, admin panel -> Biznes sozlamalari);
 * 0 bo'lsa hech narsa qilinmaydi. Oldindan to'lov Beds24 (OTA)
 * mehmonlariga tegishli va uni OTA boshqaradi.
 *
 * Yoqilsa: `cancelReservation` chaqiriladi — xona saytda darhol qayta
 * sotuvga chiqadi.
 */
export async function expireUnpaidBookings(): Promise<ExpireResult> {
  const hours = await getWebsiteUnpaidCancelHours();
  if (!(hours > 0)) return { checked: 0, cancelled: 0, codes: [] };

  const { cancelReservation } = await import("./reservations.js");

  const cutoff = new Date(Date.now() - hours * 3600_000);

  const stale = await prisma.reservation.findMany({
    where: {
      status: "PENDING_PAYMENT",
      // FAQAT sayt bronlari: qabulxona "to'lov kutilmoqda" qilib
      // qo'ygan bronni xodim o'zi kuzatadi
      source: "WEBSITE",
      code: { not: null },
      createdAt: { lt: cutoff },
      // Faqat kelajakdagi bronlar — o'tmishdagilarni tegmaymiz,
      // ular tarix
      checkOut: { gte: hotelToday() },
    },
    select: { id: true, code: true },
    take: 100,
  });

  const codes: string[] = [];

  for (const r of stale) {
    try {
      await cancelReservation(r.id);
      codes.push(r.code ?? r.id);
    } catch (e) {
      console.warn(`[public] bekor qilinmadi ${r.id}: ${String(e).slice(0, 100)}`);
    }
  }

  return { checked: stale.length, cancelled: codes.length, codes };
}
