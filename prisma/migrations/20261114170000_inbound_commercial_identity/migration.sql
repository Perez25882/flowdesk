ALTER TABLE orders ADD COLUMN "inboundSourceMessageId" TEXT;
CREATE UNIQUE INDEX "orders_inboundSourceMessageId_key" ON orders ("inboundSourceMessageId");

ALTER TABLE whatsapp_text_receipts
  ADD COLUMN "classificationCheckAt" TIMESTAMP(3),
  ADD COLUMN "classificationChecks" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "whatsapp_text_receipts_classificationCheckAt_idx" ON whatsapp_text_receipts ("classificationCheckAt");

ALTER TABLE payments ADD COLUMN "manualRequestKey" TEXT, ADD COLUMN "manualRequestHash" TEXT;
CREATE UNIQUE INDEX "payments_businessId_manualRequestKey_key" ON payments ("businessId", "manualRequestKey");
