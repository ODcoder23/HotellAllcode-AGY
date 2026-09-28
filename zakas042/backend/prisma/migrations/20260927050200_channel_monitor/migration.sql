-- ============================================================
--  Kanal kuzatuvi (Beds24) — 2026-09-27, egasi qarori
--
--  FAQAT O'QISH, FAQAT FOUNDER. PMS Beds24'dan o'qiydi va o'zi
--  bilan solishtiradi; PMS bronlari va Beds24'ga hech narsa
--  yozilmaydi. 20260926200000_remove_beds24 dagi jadvallar xuddi
--  o'sha shaklda qaytadi (zaxiradan jurnalni tiklash mumkin),
--  qo'shimcha: ChannelBooking, ChannelCalendar va
--  Reservation.externalReference (OTA bron raqami).
--
--  Faqat yangi jadval va bo'sh ustun qo'shiladi — mavjud
--  ma'lumotga tegilmaydi.
-- ============================================================

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSED', 'FAILED', 'IGNORED_DUPLICATE', 'NEEDS_MANUAL_ACTION');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('PMS_TO_CHANNEL', 'CHANNEL_TO_PMS');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('SUCCESS', 'FAILED', 'RETRYING', 'SKIPPED');

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "externalReference" TEXT;

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "propertyId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "lastError" TEXT,
    "scopes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMapping" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "roomTypeId" TEXT,
    "roomId" TEXT,
    "externalRoomTypeId" TEXT NOT NULL,
    "externalUnitId" TEXT,
    "externalName" TEXT,
    "includesMeal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "reservationId" TEXT,
    "roomId" TEXT,
    "request" JSONB,
    "response" JSONB,
    "status" "SyncStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "lastSuccessfulAt" TIMESTAMP(3),
    "lastCursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelBooking" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalRoomTypeId" TEXT NOT NULL,
    "externalUnitId" TEXT,
    "status" TEXT NOT NULL,
    "subStatus" TEXT,
    "arrival" DATE NOT NULL,
    "departure" DATE NOT NULL,
    "numAdult" INTEGER NOT NULL DEFAULT 1,
    "numChild" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "guestName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "country" TEXT,
    "source" TEXT,
    "apiReference" TEXT,
    "notes" TEXT,
    "bookedAt" TIMESTAMP(3),
    "modifiedAt" TIMESTAMP(3),
    "matchStatus" TEXT NOT NULL DEFAULT 'MISSING_IN_PMS',
    "matchNote" TEXT,
    "reservationId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelCalendar" (
    "channelId" TEXT NOT NULL,
    "externalRoomTypeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "numAvail" INTEGER,
    "price1" DECIMAL(12,2),
    "minStay" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelCalendar_pkey" PRIMARY KEY ("channelId","externalRoomTypeId","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "Channel_code_key" ON "Channel"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_channelId_propertyId_key" ON "ChannelConnection"("channelId", "propertyId");

-- CreateIndex
CREATE INDEX "ChannelMapping_channelId_roomTypeId_idx" ON "ChannelMapping"("channelId", "roomTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMapping_channelId_externalRoomTypeId_externalUnitId_key" ON "ChannelMapping"("channelId", "externalRoomTypeId", "externalUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMapping_channelId_roomId_key" ON "ChannelMapping"("channelId", "roomId");

-- CreateIndex
CREATE INDEX "WebhookEvent_channelId_externalId_idx" ON "WebhookEvent"("channelId", "externalId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_createdAt_idx" ON "WebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_channelId_eventType_externalId_payloadHash_key" ON "WebhookEvent"("channelId", "eventType", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "SyncLog_channelId_status_createdAt_idx" ON "SyncLog"("channelId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncLog_channelId_action_createdAt_idx" ON "SyncLog"("channelId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "SyncLog_reservationId_idx" ON "SyncLog"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_channelId_key_key" ON "SyncState"("channelId", "key");

-- CreateIndex
CREATE INDEX "ChannelBooking_arrival_idx" ON "ChannelBooking"("arrival");

-- CreateIndex
CREATE INDEX "ChannelBooking_matchStatus_idx" ON "ChannelBooking"("matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelBooking_channelId_externalId_key" ON "ChannelBooking"("channelId", "externalId");

-- CreateIndex
CREATE INDEX "ChannelCalendar_date_idx" ON "ChannelCalendar"("date");

-- CreateIndex
CREATE INDEX "Reservation_externalReference_idx" ON "Reservation"("externalReference");

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMapping" ADD CONSTRAINT "ChannelMapping_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMapping" ADD CONSTRAINT "ChannelMapping_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMapping" ADD CONSTRAINT "ChannelMapping_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBooking" ADD CONSTRAINT "ChannelBooking_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelCalendar" ADD CONSTRAINT "ChannelCalendar_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
