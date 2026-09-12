/**
 * GET /properties javobi
 *
 * TAXMIN (FAZA 0.5 dagi 6 faktdan 1-3):
 *   - xonalar room type darajasida (unit-level emas)
 *   - 3 room type: standard, double, deluxe
 *   - qty: 6 / 4 / 2 (02-DATABASE-SXEMA.md §4)
 *
 * Dasturchi real hisobga ulangach bu qiymatlar farq qilsa —
 * faqat shu fayl o'zgaradi, kod emas.
 */

export const properties = [
  {
    id: 12345,
    name: "Imron Hotel",
    propertyType: "hotel",
    currency: "USD",
    country: "UZ",
    city: "Toshkent",
    roomTypes: [
      {
        id: 101001,
        name: "Standard Room",
        qty: 6,
        maxPeople: 2,
        maxAdult: 2,
        maxChildren: 1,
        // unit-level mapping bo'lsa shu ro'yxat to'ldiriladi.
        // Hozircha bo'sh — room-type darajasi taxmin qilingan.
        units: [],
      },
      {
        id: 101002,
        name: "Double Room",
        qty: 4,
        maxPeople: 3,
        maxAdult: 2,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101003,
        name: "Deluxe Room",
        qty: 2,
        maxPeople: 4,
        maxAdult: 3,
        maxChildren: 2,
        units: [],
      },
    ],
  },
];

/** PMS room type -> Beds24 roomId (mapping ekranida tanlanadigan qiymatlar) */
export const ROOM_TYPE_IDS = {
  standard: 101001,
  double: 101002,
  deluxe: 101003,
} as const;
