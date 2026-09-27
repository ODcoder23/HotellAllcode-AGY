/**
 * Pul hisob-kitobi — lib/money.ts (2026-09-25)
 *
 * Egasi talabi: "hamma hisob-kitoblar mukammal bo'lishi lozim".
 * Bu fayl formulani toza (bazasiz) tekshiradi; API darajasidagi
 * moslik — api.test.ts, public.test.ts, rates.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  round2, toCents, sumMoney, nightsBetween, overlapNights, roomTotalFor,
  mealTotalFor, perNight, reservationMoney, stayRevenueIn, stayPriceFromRates,
  formatMoney,
} from "./lib/money.js";

const d = (s: string) => new Date(s + "T00:00:00.000Z");

describe("lib/money — asoslar", () => {
  it("sentga yaxlitlash float xatosiz", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(-2.675)).toBe(-2.68);
    expect(toCents(new Prisma.Decimal("33.3333"))).toBe(3333);
    expect(round2(null)).toBe(0);
  });

  it("qo'shish sentda: 0.1 + 0.2 + 0.3 = 0.6 aniq", () => {
    expect(sumMoney([0.1, 0.2, 0.3])).toBe(0.6);
    expect(sumMoney([new Prisma.Decimal("10.10"), "5.05", 4.85])).toBe(20);
  });

  it("kechalar — `[)` oraliq, kamida 1", () => {
    expect(nightsBetween(d("2030-01-01"), d("2030-01-04"))).toBe(3);
    expect(nightsBetween(d("2030-01-01"), d("2030-01-01"))).toBe(1);
    expect(overlapNights(d("2030-01-30"), d("2030-02-02"), d("2030-02-01"), d("2030-03-01"))).toBe(1);
    expect(overlapNights(d("2030-01-01"), d("2030-01-03"), d("2030-02-01"), d("2030-03-01"))).toBe(0);
  });

  it("OTA jami narxi kechalarga bo'linib, qaytib aynan o'sha summa bo'ladi", () => {
    // $100 / 3 kecha — 33.3333 saqlanadi, jami yana $100.00
    const ppn = perNight(100, 3);
    expect(ppn).toBe("33.3333");
    expect(roomTotalFor(ppn, 3)).toBe(100);
    // $200 / 7
    expect(roomTotalFor(perNight(200, 7), 7)).toBe(200);
    // Real hisobdagi Booking.com broni: $225 / 3
    expect(roomTotalFor(perNight(225, 3), 3)).toBe(225);
  });

  it("nonushta: narx x kishi x kecha", () => {
    expect(mealTotalFor(7.5, 3, 2)).toBe(45);
    expect(mealTotalFor(null, 3, 2)).toBe(0);
  });
});

describe("lib/money — bron summasi", () => {
  const base = {
    checkIn: d("2030-05-01"),
    checkOut: d("2030-05-04"),
    adults: 2,
    children: 1,
    pricePerNight: new Prisma.Decimal("45.50"),
    withMeal: true,
    mealPricePerPerson: new Prisma.Decimal("6.00"),
    status: "CONFIRMED",
    charges: [{ amount: new Prisma.Decimal("12.30") }, { amount: 7.7 }],
    payments: [{ amount: 100 }, { amount: new Prisma.Decimal("-20.00") }],
  };

  it("xona + nonushta + xizmatlar; qarz va qaytarish", () => {
    const m = reservationMoney(base);
    expect(m.nights).toBe(3);
    expect(m.roomTotal).toBe(136.5);
    expect(m.mealTotal).toBe(54);        // 6 x 3 kishi x 3 kecha
    expect(m.chargesTotal).toBe(20);
    expect(m.total).toBe(210.5);
    expect(m.paid).toBe(80);
    expect(m.remaining).toBe(130.5);
    expect(m.refundDue).toBe(0);
  });

  it("nonushtasiz bron — narx saqlangan bo'lsa ham qo'shilmaydi", () => {
    expect(reservationMoney({ ...base, withMeal: false }).mealTotal).toBe(0);
  });

  it("bekor qilingan / kelmagan — summa faqat jarima, ortiqcha to'lov qaytariladi", () => {
    const m = reservationMoney({ ...base, status: "CANCELLED", cancellationFee: 45.5 });
    expect(m.total).toBe(45.5);
    expect(m.refundDue).toBe(34.5);
    expect(m.remaining).toBe(0);
    expect(reservationMoney({ ...base, status: "no_show" }).total).toBe(0);
  });

  it("to'liq to'langanda qarz aniq 0 (float qoldig'isiz)", () => {
    const m = reservationMoney({
      ...base, withMeal: false, charges: [],
      pricePerNight: 0.1, checkOut: d("2030-05-04"),
      payments: [{ amount: 0.1 }, { amount: 0.1 }, { amount: 0.1 }],
    });
    expect(m.total).toBe(0.3);
    expect(m.remaining).toBe(0);
    expect(m.refundDue).toBe(0);
  });

  it("davr daromadi kechalar bo'yicha taqsimlanadi (oy chegarasi)", () => {
    const r = { ...base, checkIn: d("2030-05-30"), checkOut: d("2030-06-02") };
    const may = stayRevenueIn(r, d("2030-05-01"), d("2030-06-01"));
    const june = stayRevenueIn(r, d("2030-06-01"), d("2030-07-01"));
    expect(may).toEqual({ nights: 2, room: 91, meal: 36 });
    expect(june).toEqual({ nights: 1, room: 45.5, meal: 18 });
    expect(may.room + june.room).toBe(reservationMoney(r).roomTotal);
  });
});

describe("lib/money — tarif oralig'i va ko'rinish", () => {
  it("har kecha o'z tarifi bilan qo'shiladi", () => {
    const s = stayPriceFromRates([100, 120, 130], 3)!;
    expect(s.roomTotal).toBe(350);
    expect(roomTotalFor(s.perNight, 3)).toBe(350);
  });

  it("narxsiz kecha belgilanganlar o'rtachasi bilan to'ldiriladi", () => {
    expect(stayPriceFromRates([100, 120], 3)!.roomTotal).toBe(330);
    expect(stayPriceFromRates([], 3)).toBeNull();
  });

  it("ko'rinish: so'm, minglik ajratkich oddiy bo'shliq", () => {
    expect(formatMoney(450000)).toBe("450 000 so'm");
    expect(formatMoney(1250000.4)).toBe("1 250 000 so'm");
    expect(formatMoney(-20000)).toBe("-20 000 so'm");
    expect(formatMoney(0)).toBe("0 so'm");
    // Bo'linmas bo'shliq (U+00A0) qolmasin — Telegram va eksportda buziladi
    expect(formatMoney(1234567)).not.toMatch(/[\u00a0\u202f]/);
  });
});
