-- CreateEnum
CREATE TYPE "ReservationOrigin" AS ENUM ('PMS', 'CHANNEL');

-- AlterEnum
ALTER TYPE "ReservationSource" ADD VALUE 'OSTROVOK';

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "externalReference" TEXT,
ADD COLUMN     "origin" "ReservationOrigin" NOT NULL DEFAULT 'PMS',
ALTER COLUMN "currency" SET DEFAULT 'USD';

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

-- AddForeignKey
ALTER TABLE "ChannelBlock" ADD CONSTRAINT "ChannelBlock_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBlock" ADD CONSTRAINT "ChannelBlock_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill (qo'lda qo'shilgan, 2026-09-25): Beds24'dan kelgan eski
-- bronlar. Ilgari egalik `source` bo'yicha taxmin qilinardi — shu
-- qoida saqlanadi: OTA manbali va Beds24 raqami bor bron CHANNEL.
-- `OTHER` ham kiradi — Ostrovok ilgari OTHER bo'lib kelardi; xato
-- bo'lsa bron faqat "qulflanadi", Beds24'dagi OTA broni buzilmaydi.
-- Sayt bronlari (`code` bor) har doim PMS.
UPDATE "Reservation"
SET "origin" = 'CHANNEL'
WHERE "channelId" IS NOT NULL
  AND "externalReservationId" IS NOT NULL
  AND "code" IS NULL
  AND "source" IN ('BOOKING_COM', 'AIRBNB', 'EXPEDIA', 'OTHER');

-- OTA raqami ilgari izohga "[Booking.com #123456]" ko'rinishida yozilardi
UPDATE "Reservation"
SET "externalReference" = substring("notes" from '#([^\]\s]+)\]')
WHERE "origin" = 'CHANNEL'
  AND "externalReference" IS NULL
  AND "notes" ~ '^\[[^\]]* #[^\]\s]+\]';

-- Kechalik narx 4 xona aniqlikda (2026-09-25): OTA jami narxi kechalarga
-- bo'linganda sent yo'qolmasin. Mavjud qiymatlar o'zgarmaydi.
ALTER TABLE "Reservation" ALTER COLUMN "pricePerNight" SET DATA TYPE DECIMAL(12,4);
