BEGIN;
ALTER TYPE "WhatsAppTextReceiptStatus" ADD VALUE 'WAITING_MEDIA';
ALTER TABLE "whatsapp_text_receipts"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'TEXT',
  ADD COLUMN "messageType" "MessageType" NOT NULL DEFAULT 'TEXT',
  ADD COLUMN "mediaId" TEXT,
  ADD COLUMN "mediaMime" TEXT,
  ADD COLUMN "mediaDigest" TEXT,
  ADD COLUMN "mediaArchivedAt" TIMESTAMP(3),
  ADD COLUMN "echoSender" TEXT,
  ADD COLUMN "reactionEmoji" TEXT,
  ADD COLUMN "reactionTarget" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "ownershipId" BIGINT,
  ADD COLUMN "mediaClaims" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "whatsapp_receipt_kind" CHECK (kind IN ('TEXT', 'MEDIA', 'ECHO', 'INTERACTION'));
CREATE INDEX "whatsapp_text_receipts_waMessageId_idx" ON "whatsapp_text_receipts"("waMessageId");
ALTER TABLE "messages" ADD COLUMN "mediaPhoneNumberId" TEXT;

CREATE TABLE "whatsapp_phone_ownership" (
  "id" BIGSERIAL PRIMARY KEY,
  "phoneNumberId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3)
);
CREATE INDEX "whatsapp_phone_ownership_phoneNumberId_startedAt_idx"
  ON "whatsapp_phone_ownership"("phoneNumberId", "startedAt");
CREATE UNIQUE INDEX "whatsapp_phone_ownership_current"
  ON "whatsapp_phone_ownership"("phoneNumberId") WHERE "endedAt" IS NULL;

INSERT INTO "whatsapp_phone_ownership" ("phoneNumberId", "businessId", "startedAt")
SELECT "waPhoneNumberId", id, timezone('UTC', clock_timestamp()) FROM businesses
WHERE "waPhoneNumberId" IS NOT NULL AND "deletedAt" IS NULL;

UPDATE "whatsapp_text_receipts" r SET "ownershipId" = o.id
FROM "whatsapp_phone_ownership" o
WHERE r."phoneNumberId" = o."phoneNumberId" AND r."businessId" = o."businessId"
  AND r."finishedAt" IS NULL;

CREATE FUNCTION track_whatsapp_phone_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  boundary TIMESTAMP(3) := timezone('UTC', clock_timestamp());
  old_phone TEXT;
  new_phone TEXT;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."deletedAt" IS NULL THEN old_phone := OLD."waPhoneNumberId"; END IF;
  IF TG_OP <> 'DELETE' AND NEW."deletedAt" IS NULL THEN new_phone := NEW."waPhoneNumberId"; END IF;
  IF old_phone IS NOT DISTINCT FROM new_phone THEN RETURN NULL; END IF;
  IF old_phone IS NOT NULL THEN
    UPDATE "whatsapp_phone_ownership" SET "endedAt" = boundary
    WHERE "phoneNumberId" = old_phone AND "businessId" = OLD.id AND "endedAt" IS NULL;
  END IF;
  IF new_phone IS NOT NULL THEN
    INSERT INTO "whatsapp_phone_ownership" ("phoneNumberId", "businessId", "startedAt")
    VALUES (new_phone, NEW.id, boundary);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "business_whatsapp_phone_ownership"
AFTER INSERT OR UPDATE OF "waPhoneNumberId", "deletedAt" OR DELETE ON businesses
FOR EACH ROW EXECUTE FUNCTION track_whatsapp_phone_ownership();
COMMIT;
