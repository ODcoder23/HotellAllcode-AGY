-- Cheklovlar (TZ 10-band): minStay, maxStay, kirish/chiqish taqiqi.
-- null = PMS boshqarmaydi (Beds24'ga yuborilmaydi). Ilgari minStay hamma
-- qatorda standart 1 edi va hech qayerda ishlatilmasdi — boshqarilmagan
-- deb belgilanadi, aks holda Beds24'dagi "kamida 3 kecha" 1 ga tushardi.
ALTER TABLE "RatePlan" ALTER COLUMN "minStay" DROP NOT NULL;
ALTER TABLE "RatePlan" ALTER COLUMN "minStay" DROP DEFAULT;
UPDATE "RatePlan" SET "minStay" = NULL;

ALTER TABLE "RatePlan" ADD COLUMN "maxStay" INTEGER;
ALTER TABLE "RatePlan" ADD COLUMN "closedArrival" BOOLEAN;
ALTER TABLE "RatePlan" ADD COLUMN "closedDeparture" BOOLEAN;
