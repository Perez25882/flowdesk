-- What a picture shows, so a reply to it can be answered.
--
-- A shop posts a flyer to their WhatsApp Status and twenty people reply "how
-- much?". Each of those arrives as a message whose only context is the id of
-- the Status. Until now, if that Status carried no caption, the assistant had
-- nothing at all to go on and asked the customer what they meant — while the
-- customer was looking straight at the thing they meant.
--
-- Computed once per image and read by every reply to it. Nullable because most
-- messages are text and will never have one.

ALTER TABLE "messages" ADD COLUMN "mediaDescription" TEXT;
ALTER TABLE "messages" ADD COLUMN "mediaDescribedBy" TEXT;

-- Only the rows that actually carry an image are ever looked up this way, and
-- they are a small fraction of the table.
CREATE INDEX "messages_media_described_idx"
  ON "messages" ("businessId", "waMessageId")
  WHERE "mediaDescription" IS NOT NULL;
