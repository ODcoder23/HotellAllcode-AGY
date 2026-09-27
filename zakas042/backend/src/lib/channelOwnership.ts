/**
 * Bron OTA'nikimi — mijoz qarori Q9 ("Beds24 tanlovi doim ustuvor").
 *
 * OTA'dan (Booking.com, Ostrovok va h.k.) kelgan bronning sanasi,
 * narxi, mehmon soni va bekor qilinishi OTA'da boshqariladi. PMS
 * ularni o'zgartirmaydi (`services/reservations.ts` `assertChannelAllows`),
 * Beds24'ga faqat xona/unit va check-in/out belgisini yuboradi
 * (`reservationSync.ts`, adapter `ota` rejimi).
 *
 * BITTA JOY: backend himoyasi ham, Beds24'ga yuborish rejimi ham,
 * Shaxmatka tugmalari ham (`serializeReservation().channelOwned`) shu
 * qoidadan foydalanadi — bir-biridan uzoqlashmasin.
 *
 * QOIDA: egalik `origin` maydonidan olinadi, `source` nomidan taxmin
 * qilinmaydi. Xodim PMS'da qo'lda "Booking.com" manbali bron yaratsa
 * ham u PMS broni (`origin = PMS`) — Beds24 importi uni OTA raqami
 * bo'yicha topsa, CHANNEL ga o'tkazib bog'laydi (webhookProcessor.ts).
 *
 *   origin = PMS                      -> PMS boshqaradi (full)
 *   origin = CHANNEL, source = DIRECT -> Beds24 panelida yaratilgan,
 *                                        OTA yo'q -> PMS boshqaradi (full)
 *   origin = CHANNEL, boshqa manba    -> OTA'niki (ota)
 *
 * `OTHER` + CHANNEL — Beds24 bergan, lekin bizga noma'lum kanal kodi
 * (masalan, keyin ulanadigan Agoda). Xavfsiz tomon: OTA deb olinadi.
 */

export function isChannelOwned(r: {
  origin: string;
  source: string;
  channelId: string | null;
  externalReservationId: string | null;
}): boolean {
  if (!r.channelId || !r.externalReservationId) return false;
  return r.origin === "CHANNEL" && r.source !== "DIRECT";
}
