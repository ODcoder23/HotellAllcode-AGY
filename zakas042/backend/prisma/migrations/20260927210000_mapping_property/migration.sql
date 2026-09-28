-- TZ 11-band: mapping'da Beds24 obyekti (external_property_id).
-- Mavjud bog'lanishlar hozirgi faol ulanish obyektiga tegishli.
ALTER TABLE "ChannelMapping" ADD COLUMN "externalPropertyId" TEXT;

UPDATE "ChannelMapping" m
SET "externalPropertyId" = c."propertyId"
FROM "ChannelConnection" c
WHERE c."channelId" = m."channelId" AND c."isActive" = true;
