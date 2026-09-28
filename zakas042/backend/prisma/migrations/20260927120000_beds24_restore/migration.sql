-- ============================================================
--  Beds24 integratsiyasi AVVALGIDEK qaytadi (2026-09-27, egasi qarori)
--
--  2026-09-26 da olib tashlangan ikki tomonlama integratsiya qaytadi
--  (BEDS24.md): Beds24 bronlari PMS'ga tushadi, PMS bronlari, narxlari
--  va yopiq kunlari Beds24'ga yuboriladi. Beds24'dan kelgan bron obyekt
--  valyutasida (USD) — tagida so'm, bron kelgan kundagi kurs bilan.
--
--  Shu bilan birga:
--    - kuzatuv nusxalari (ChannelBooking, ChannelCalendar) o'chiriladi —
--      Beds24 bronlari endi to'g'ridan-to'g'ri `Reservation` bo'ladi.
--      Jadvallar bo'sh (ulanish hali qilinmagan, 2026-09-27 tekshirildi)
--    - STOP (tizim nazorati) olib tashlanadi: sozlama o'chadi, kelgusi
--      STOP kunlari ochiladi (o'tganlari tarix bo'lib qoladi)
--
--  Mavjud narxlar Beds24'ga AVTOMATIK YUBORILMAYDI: `syncedAt` bo'sh
--  ("yuborilmagan") qoladi, narx faqat admin o'zgartirganda yoki
--  "Beds24'ga yuborish" bosilganda ketadi — Booking.com'dagi jonli narx
--  kutilmaganda o'zgarib ketmasin.
-- ============================================================

-- CreateEnum
CREATE TYPE "ReservationOrigin" AS ENUM ('PMS', 'CHANNEL');

-- CreateEnum
CREATE TYPE "EntitySyncStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'REJECTED', 'NOT_APPLICABLE');

-- DropForeignKey
ALTER TABLE "ChannelBooking" DROP CONSTRAINT "ChannelBooking_channelId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelCalendar" DROP CONSTRAINT "ChannelCalendar_channelId_fkey";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "channelId" TEXT,
ADD COLUMN     "exchangeRate" DECIMAL(14,4),
ADD COLUMN     "externalPaymentId" TEXT,
ADD COLUMN     "originalAmount" DECIMAL(14,2),
ADD COLUMN     "originalCurrency" TEXT;

-- AlterTable
ALTER TABLE "RatePlan" ADD COLUMN     "channelPrice" DECIMAL(12,2),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'pms',
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "channelId" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'UZS',
ADD COLUMN     "exchangeRate" DECIMAL(14,4),
ADD COLUMN     "externalReservationId" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "origin" "ReservationOrigin" NOT NULL DEFAULT 'PMS',
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncStatus" "EntitySyncStatus" NOT NULL DEFAULT 'PENDING';

-- Mavjud bronlar: faol va hali tugamaganlari Beds24'ga ulangandan keyin
-- yuboriladi (PENDING — OTA shu xonalarni sotmasin). Tugagan, bekor
-- qilingan, kelmagan bronlar — tarix, Beds24'ga yuborilmaydi
UPDATE "Reservation"
SET "syncStatus" = 'NOT_APPLICABLE'
WHERE status IN ('CHECKED_OUT', 'CANCELLED', 'NO_SHOW')
   OR "checkOut" < CURRENT_DATE;

-- DropTable
DROP TABLE "ChannelBooking";

-- DropTable
DROP TABLE "ChannelCalendar";

-- CreateTable
CREATE TABLE "ChannelBlock" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "externalId" TEXT,
    "origin" "ReservationOrigin" NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncStatus" "EntitySyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelBlock_roomId_isActive_idx" ON "ChannelBlock"("roomId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelBlock_channelId_externalId_key" ON "ChannelBlock"("channelId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_channelId_externalPaymentId_key" ON "Payment"("channelId", "externalPaymentId");

-- CreateIndex
CREATE INDEX "RatePlan_syncedAt_idx" ON "RatePlan"("syncedAt");

-- CreateIndex
CREATE INDEX "Reservation_syncStatus_idx" ON "Reservation"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_channelId_externalReservationId_key" ON "Reservation"("channelId", "externalReservationId");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBlock" ADD CONSTRAINT "ChannelBlock_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBlock" ADD CONSTRAINT "ChannelBlock_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- STOP olib tashlanadi (Q17 bekor, 2026-09-27) --------------------
-- Kelgusi STOP kunlari ochiladi; o'tgan kunlar tarix sifatida qoladi
UPDATE "RoomDayStatus"
SET "isBlocked" = false, "blockReason" = NULL
WHERE "blockReason" LIKE 'STOP:%' AND date >= CURRENT_DATE;

DELETE FROM "Settings" WHERE key = 'SALES_STOP';
