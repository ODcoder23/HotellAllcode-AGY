-- Tizim valyutasi so'm, faqat Beds24 bronlari dollarda (egasi qarori
-- Q15, 2026-09-25 — Q13 "hammasi USD" bekor qilindi).
-- Faqat ustun qo'shiladi va standart o'zgaradi — ma'lumot o'chmaydi.

-- Yangi PMS bronlari (sayt, qabulxona) so'mda
ALTER TABLE "Reservation" ALTER COLUMN "currency" SET DEFAULT 'UZS';

-- Dollar bron: bron kelgan kundagi kurs (1 USD = N so'm)
ALTER TABLE "Reservation" ADD COLUMN "exchangeRate" DECIMAL(14,4);

-- To'lov boshqa valyutada qabul qilinsa: asl summa, valyuta, kurs
ALTER TABLE "Payment" ADD COLUMN "originalAmount" DECIMAL(14,2);
ALTER TABLE "Payment" ADD COLUMN "originalCurrency" TEXT;
ALTER TABLE "Payment" ADD COLUMN "exchangeRate" DECIMAL(14,4);

-- Beds24'dagi narx (kanal valyutasida) — so'm narxdan kurs bo'yicha
ALTER TABLE "RatePlan" ADD COLUMN "channelPrice" DECIMAL(12,2);
