/**
 * Beds24 <-> PMS status mapping — TZ 8-band
 *
 * Mijoz qarori Q5 (ikki yangi status), Q7 (check-in/out sync),
 * Q9 (2026-09-25: "Beds24 tanlovi doim ustuvor").
 *
 * NEGA BITTA FAYL: aniq qiymatlar Beds24 hisobi sozlamasiga qarab
 * farq qilishi mumkin. Nomuvofiqlik chiqsa — faqat shu fayl
 * o'zgaradi, qolgan kod tegilmaydi.
 *
 * REAL API BILAN TEKSHIRILDI (2026-09-25, apiV2.yaml):
 *
 *   status:    confirmed | request | new | cancelled | black | inquiry
 *   subStatus: actionRequired | allotment | cancelledByGuest |
 *              cancelledByHost | noShow | waitlist | walkin | none |
 *              nonPayment
 *
 *   - `arrived` / `departed` degan subStatus YO'Q. Ilgari check-in
 *     shu bilan yuborilardi — Beds24 validatsiya xatosi qaytarardi.
 *     Endi check-in/out bron BAYROG'I (`flagText`, 32 belgigacha)
 *     orqali ko'rsatiladi: Beds24 kalendarida xodim ko'radi (Q7).
 *   - `black` — mehmon broni EMAS, xona yopilgani (ta'mir, egasi
 *     uchun). Ilgari NO_SHOW deb o'qilardi: Beds24'da yopilgan xona
 *     PMS'da "kelmagan mehmon" bo'lib chiqardi.
 *   - `new` — yangi, hali ko'rilmagan, lekin JOY BAND bron. Ilgari
 *     to'lov bo'lmasa PENDING_PAYMENT bo'lardi va 24 soatdan keyin
 *     avtomatik bekor qilinib, bekor qilish Beds24'ga yuborilardi —
 *     haqiqiy OTA broni yo'qolardi.
 *   - `inquiry` — so'rov, xonani band qilmaydi.
 *
 * TZ 8-band PMS'da OLTITA statusni talab qiladi:
 *   PENDING_PAYMENT, CONFIRMED, CHECKED_IN, CHECKED_OUT,
 *   CANCELLED, NO_SHOW
 * Beds24 biror statusni qo'llab-quvvatlamasa, PMS tomondagi status
 * baribir o'zgarmaydi — kanal cheklovi PMS'ga ta'sir qilmaydi.
 */

import type { ReservationStatus } from "@prisma/client";
import type { ExternalReservation, ExternalKind } from "../channel/types.js";

/** Bayroq matnlari — Beds24 `flagText` (ko'pi bilan 32 belgi) */
export const FLAG = {
  checkedIn: { text: "Checked-in", color: "22c55e" },
  checkedOut: { text: "Checked-out", color: "9ca3af" },
  /** OTA bronida: statusni OTA boshqaradi, biz faqat belgi qo'yamiz */
  noShow: { text: "No-show", color: "ef4444" },
} as const;

/** Beds24'ga yuboriladigan status juftligi */
export type Beds24StatusPair = {
  status: string;
  subStatus?: string;
  flagText?: string;
  flagColor?: string;
};

/** Tashqi yozuv mehmon bronimi, xona yopilishimi yoki so'rovmi */
export function classifyExternal(ext: Pick<ExternalReservation, "status">): ExternalKind {
  const s = ext.status.toLowerCase();
  if (s === "black") return "block";
  if (s === "inquiry") return "inquiry";
  return "reservation";
}

function flagOf(ext: Pick<ExternalReservation, "flagText">): "in" | "out" | "noshow" | null {
  const f = (ext.flagText ?? "").trim().toLowerCase();
  if (f === FLAG.checkedOut.text.toLowerCase()) return "out";
  if (f === FLAG.checkedIn.text.toLowerCase()) return "in";
  if (f === FLAG.noShow.text.toLowerCase()) return "noshow";
  return null;
}

/**
 * Beds24 -> PMS.
 *
 * `black` va `inquiry` bu yerga kelmasligi kerak — ular
 * `classifyExternal` bilan oldinroq ajratiladi.
 */
export function toPmsStatus(
  ext: Pick<ExternalReservation, "status" | "subStatus" | "flagText">
): ReservationStatus {
  const s = ext.status.toLowerCase();
  const sub = ext.subStatus?.toLowerCase();

  if (s === "cancelled" || s === "canceled") {
    return sub === "noshow" ? "NO_SHOW" : "CANCELLED";
  }
  if (s === "request" || s === "inquiry") return "PENDING_PAYMENT";

  if (s === "confirmed" || s === "new") {
    const flag = flagOf(ext);
    if (sub === "noshow" || flag === "noshow") return "NO_SHOW";
    if (flag === "out") return "CHECKED_OUT";
    if (flag === "in") return "CHECKED_IN";
    return "CONFIRMED";
  }

  // Noma'lum status — eng xavfsiz taxmin. Bronni yo'qotgandan
  // ko'ra tasdiqlangan deb qabul qilish yaxshi (TZ 17-band).
  return "CONFIRMED";
}

/**
 * PMS -> Beds24 (mijoz qarori Q7).
 *
 * CHECK-IN / CHECK-OUT: Beds24'da alohida status ham, subStatus ham
 * yo'q. Bron `confirmed` qoladi, bayroq qo'yiladi — Beds24
 * kalendarida xodim ko'radi, qaytib kelganda PMS o'qiydi.
 *
 * NO_SHOW: `cancelled` + `noShow` — xona Beds24'da ham bo'shaydi
 * (PMS'dagi overbooking constraint ham NO_SHOW'ni band sanamaydi).
 */
export function toBeds24Status(s: ReservationStatus): Beds24StatusPair {
  switch (s) {
    case "PENDING_PAYMENT": return { status: "request" };
    case "CONFIRMED":       return { status: "confirmed" };
    case "CHECKED_IN":      return { status: "confirmed", flagText: FLAG.checkedIn.text, flagColor: FLAG.checkedIn.color };
    case "CHECKED_OUT":     return { status: "confirmed", flagText: FLAG.checkedOut.text, flagColor: FLAG.checkedOut.color };
    case "CANCELLED":       return { status: "cancelled" };
    case "NO_SHOW":         return { status: "cancelled", subStatus: "noShow" };
  }
}

/**
 * OTA bronini yangilashda yuboriladigan qism.
 *
 * OTA broni statusini (bekor qilish, sana) OTA boshqaradi — PMS
 * Beds24'dagi statusni o'zgartirmaydi, faqat bayroq qo'yadi. Aks
 * holda Beds24 xonani bo'shatadi, Booking.com'da esa bron turaveradi.
 * `null` — yuboradigan narsa yo'q.
 */
export function otaFlagFor(s: ReservationStatus): { flagText: string; flagColor: string } | null {
  switch (s) {
    case "CHECKED_IN":  return { flagText: FLAG.checkedIn.text, flagColor: FLAG.checkedIn.color };
    case "CHECKED_OUT": return { flagText: FLAG.checkedOut.text, flagColor: FLAG.checkedOut.color };
    case "NO_SHOW":     return { flagText: FLAG.noShow.text, flagColor: FLAG.noShow.color };
    default:            return null;
  }
}

/**
 * Beds24'dan kelgan statusni PMS'dagi holat bilan qo'shadi.
 *
 * QOIDA (Q9): Beds24 ustuvor. Lekin Beds24 bilmaydigan narsa bor —
 * mehmon xonada turibdimi. Shuning uchun:
 *
 *   - Beds24 "confirmed" desa, PMS'dagi CHECKED_IN/CHECKED_OUT
 *     SAQLANADI (Beds24'da bunday status yo'q, bu qaytish emas).
 *   - Check-in/out faqat oldinga yuradi (bayroq orqali).
 *   - Bekor qilish Beds24'dan kelsa qabul qilinadi — lekin mehmon
 *     allaqachon xonada bo'lsa (CHECKED_IN/OUT) PMS holati qoladi va
 *     `conflict` qaytadi: admin qo'lda hal qiladi. Xonada turgan
 *     mehmonni jimgina "bekor qilingan" qilib bo'lmaydi.
 *   - Qolgan hamma holatda Beds24 qiymati olinadi.
 */
export function mergeIncomingStatus(
  current: ReservationStatus,
  incoming: ReservationStatus
): { status: ReservationStatus; conflict?: string } {
  const inHouse = current === "CHECKED_IN" || current === "CHECKED_OUT";

  if (incoming === "CANCELLED" || incoming === "NO_SHOW") {
    if (inHouse) {
      return {
        status: current,
        conflict:
          `Beds24 bronni ${incoming === "CANCELLED" ? "bekor qilingan" : "kelmagan"} deb ` +
          `ko'rsatdi, lekin mehmon PMS'da ${current === "CHECKED_IN" ? "xonada" : "chiqib ketgan"}. ` +
          `Qo'lda tekshiring.`,
      };
    }
    return { status: incoming };
  }

  if (current === "CHECKED_OUT") return { status: current };
  if (current === "CHECKED_IN") {
    return { status: incoming === "CHECKED_OUT" ? "CHECKED_OUT" : current };
  }
  return { status: incoming };
}
