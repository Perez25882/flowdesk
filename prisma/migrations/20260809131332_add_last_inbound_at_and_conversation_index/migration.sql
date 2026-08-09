-- Meta's 24-hour customer-service window opens only on a message FROM the
-- customer. `customers.lastInteractionAt` cannot serve that purpose because the
-- owner's own replies from the WhatsApp Business app (smb_message_echoes) also
-- write it, which pushes our idea of the window past the real one.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "lastInboundAt" TIMESTAMP(3);

-- Backfill from the newest genuinely inbound message per customer.
--
-- Without this every existing customer starts NULL. That is not merely "no
-- history": a NULL is currently read as "window open" by shouldSendAutoReply,
-- so the whole install would start sending outside the window and collecting
-- non-retryable Meta rejections. Derive the real value instead.
UPDATE "customers" AS c
SET "lastInboundAt" = m."lastInbound"
FROM (
  SELECT "customerId", MAX("createdAt") AS "lastInbound"
  FROM "messages"
  WHERE "direction" = 'INBOUND' AND "customerId" IS NOT NULL
  GROUP BY "customerId"
) AS m
WHERE c."id" = m."customerId";

-- CreateIndex
CREATE INDEX "messages_businessId_customerId_createdAt_idx" ON "messages"("businessId", "customerId", "createdAt" DESC);
