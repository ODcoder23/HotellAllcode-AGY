-- ============================================================
--  Beds24 integratsiyasini olib tashlash (2026-09-26, egasi qarori)
--
--  Tizim mustaqil PMS bo'ladi: kanal jadvallari, sinxronizatsiya
--  ustunlari va valyuta qatlami (faqat Beds24 dollar bronlari uchun
--  edi) olib tashlanadi. Hamma summa so'mda.
--
--  TARTIB (SERVER.md, "Beds24'ni olib tashlash"):
--    1. zaxira (pg_dump)
--    2. npm run beds24:purge -- --confirm=<baza>   (Beds24 bronlari va
--       qoldiqlari — shu migratsiyadan OLDIN, keyin ularni ajratib
--       bo'lmaydi)
--    3. npx prisma migrate deploy                  (shu fayl)
--
--  2-qadam o'tkazib yuborilsa ham ma'lumot yo'qolmaydi: qolgan dollar
--  bronlar bron kursi bilan so'mga o'giriladi (pastda) va oddiy PMS
--  broni bo'lib qoladi.
-- ============================================================

-- --- 1. Chet valyutadagi bronlar -> so'm ---------------------------
--
-- Kurs: bronga yozilgani (bron kelgan kun), bo'lmasa Settings.FX_RATE_*
-- dagi oxirgi kurs. Ikkalasi ham bo'lmasa migratsiya TO'XTAYDI —
-- taxminiy kurs bilan pul summasini buzgandan ko'ra to'xtagan yaxshi.
WITH fx AS MATERIALIZED (
  SELECT substring(key FROM 9) AS cur, value
  FROM "Settings"
  WHERE key LIKE 'FX\_RATE\_%'
), fx_rate AS (
  SELECT cur, (value::jsonb ->> 'rate')::numeric AS rate
  FROM fx
  WHERE (value::jsonb ->> 'rate') ~ '^[0-9]+(\.[0-9]+)?$'
)
UPDATE "Reservation" r
SET "exchangeRate" = f.rate
FROM fx_rate f
WHERE upper(r.currency) <> 'UZS'
  AND (r."exchangeRate" IS NULL OR r."exchangeRate" <= 0)
  AND f.cur = upper(r.currency)
  AND f.rate > 0;

DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM "Reservation"
  WHERE upper(currency) <> 'UZS' AND ("exchangeRate" IS NULL OR "exchangeRate" <= 0);
  IF missing > 0 THEN
    RAISE EXCEPTION
      'remove_beds24: % ta chet valyutali bronning kursi noma''lum. Avval "npm run beds24:purge" bilan Beds24 bronlarini tozalang yoki kursni kiriting.',
      missing;
  END IF;
END $$;

-- To'lov: so'mda qabul qilingan bo'lsa — aynan tushgan so'm, aks holda x kurs
UPDATE "Payment" p
SET amount = CASE
    WHEN upper(p."originalCurrency") = 'UZS' AND p."originalAmount" IS NOT NULL THEN p."originalAmount"
    ELSE round(p.amount * r."exchangeRate", 2)
  END
FROM "Reservation" r
WHERE p."reservationId" = r.id AND upper(r.currency) <> 'UZS';

UPDATE "Charge" c
SET amount = round(c.amount * r."exchangeRate", 2)
FROM "Reservation" r
WHERE c."reservationId" = r.id AND upper(r.currency) <> 'UZS';

UPDATE "Reservation"
SET "pricePerNight"      = round("pricePerNight" * "exchangeRate", 4),
    "mealPricePerPerson" = round("mealPricePerPerson" * "exchangeRate", 2),
    "cancellationFee"    = round("cancellationFee" * "exchangeRate", 2),
    currency             = 'UZS'
WHERE upper(currency) <> 'UZS';

-- So'm bronga Beds24'dan (dollarda) kelgan to'lov allaqachon so'mda
-- yozilgan (`amount`), asl dollar qiymati bilan birga ketadi.

-- --- 2. Endi ma'nosiz sozlamalar -----------------------------------
DELETE FROM "Settings"
WHERE key IN ('SOURCE_OF_TRUTH_RATES', 'SOURCE_OF_TRUTH_AVAILABILITY')
   OR key LIKE 'FX\_RATE\_%';

-- --- 3. Yangi foreign key'lar uchun yetim yozuvlar -----------------
-- Availability — kesh, bronlardan qayta hisoblanadi
DELETE FROM "Availability" a
WHERE NOT EXISTS (SELECT 1 FROM "RoomType" t WHERE t.id = a."roomTypeId");

-- Avtomatik komissiya o'chirilgan bronga ishora qilsa — hisobot uni
-- baribir qayta hisoblaydi (services/expenses.ts)
DELETE FROM "Expense" e
WHERE e."reservationId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Reservation" r WHERE r.id = e."reservationId");

-- --- 4. Tuzilma (prisma migrate diff) ------------------------------

-- DropForeignKey
ALTER TABLE "ChannelBlock" DROP CONSTRAINT "ChannelBlock_channelId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelBlock" DROP CONSTRAINT "ChannelBlock_roomId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelConnection" DROP CONSTRAINT "ChannelConnection_channelId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelMapping" DROP CONSTRAINT "ChannelMapping_channelId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelMapping" DROP CONSTRAINT "ChannelMapping_roomId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelMapping" DROP CONSTRAINT "ChannelMapping_roomTypeId_fkey";

-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_channelId_fkey";

-- DropForeignKey
ALTER TABLE "SyncLog" DROP CONSTRAINT "SyncLog_channelId_fkey";

-- DropForeignKey
ALTER TABLE "SyncState" DROP CONSTRAINT "SyncState_channelId_fkey";

-- DropForeignKey
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_channelId_fkey";

-- DropIndex
DROP INDEX "Availability_syncedAt_idx";

-- DropIndex
DROP INDEX "Payment_channelId_externalPaymentId_key";

-- DropIndex
DROP INDEX "RatePlan_syncedAt_idx";

-- DropIndex
DROP INDEX "Reservation_channelId_externalReservationId_key";

-- DropIndex
DROP INDEX "Reservation_syncStatus_idx";

-- AlterTable
ALTER TABLE "Availability" DROP COLUMN "syncedAt",
DROP COLUMN "syncedCount";

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "channelId",
DROP COLUMN "exchangeRate",
DROP COLUMN "externalPaymentId",
DROP COLUMN "originalAmount",
DROP COLUMN "originalCurrency";

-- AlterTable
ALTER TABLE "RatePlan" DROP COLUMN "channelPrice",
DROP COLUMN "source",
DROP COLUMN "syncError",
DROP COLUMN "syncedAt";

-- AlterTable
ALTER TABLE "Reservation" DROP COLUMN "channelId",
DROP COLUMN "currency",
DROP COLUMN "exchangeRate",
DROP COLUMN "externalReference",
DROP COLUMN "externalReservationId",
DROP COLUMN "lastSyncedAt",
DROP COLUMN "origin",
DROP COLUMN "syncStatus";

-- DropTable
DROP TABLE "Channel";

-- DropTable
DROP TABLE "ChannelBlock";

-- DropTable
DROP TABLE "ChannelConnection";

-- DropTable
DROP TABLE "ChannelMapping";

-- DropTable
DROP TABLE "SyncLog";

-- DropTable
DROP TABLE "SyncState";

-- DropTable
DROP TABLE "WebhookEvent";

-- DropEnum
DROP TYPE "EntitySyncStatus";

-- DropEnum
DROP TYPE "ReservationOrigin";

-- DropEnum
DROP TYPE "SyncDirection";

-- DropEnum
DROP TYPE "SyncStatus";

-- DropEnum
DROP TYPE "WebhookStatus";

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- 5. Sessiya xavfsizligi ----------------------------------------
-- Parol o'zgarganda eski token'lar bekor bo'lishi uchun (lib/authMiddleware.ts)
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
