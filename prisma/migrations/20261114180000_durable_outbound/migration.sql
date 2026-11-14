CREATE TYPE "WhatsAppSendState" AS ENUM (
  'AUTHORIZED', 'QUEUED', 'SENDING', 'PROVIDER_ACCEPTED', 'DELIVERED', 'READ', 'FAILED', 'RETRY_PENDING', 'REVIEW_REQUIRED'
);
CREATE TABLE whatsapp_sends (
  id TEXT PRIMARY KEY,
  "businessId" TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "eventKey" TEXT NOT NULL,
  payload JSONB NOT NULL,
  state "WhatsAppSendState" NOT NULL DEFAULT 'AUTHORIZED',
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "phoneNumberId" TEXT,
  "providerMessageId" TEXT,
  reason TEXT,
  "acceptedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "whatsapp_sends_businessId_eventKey_key" ON whatsapp_sends ("businessId", "eventKey");
CREATE UNIQUE INDEX "whatsapp_sends_phoneNumberId_providerMessageId_key" ON whatsapp_sends ("phoneNumberId", "providerMessageId");
CREATE INDEX "whatsapp_sends_nextAttemptAt_idx" ON whatsapp_sends ("nextAttemptAt");
CREATE INDEX "whatsapp_sends_state_leaseUntil_idx" ON whatsapp_sends (state, "leaseUntil");

CREATE TABLE whatsapp_delivery_receipts (
  id TEXT PRIMARY KEY,
  "phoneNumberId" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  "outboundId" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX whatsapp_delivery_receipts_identity ON whatsapp_delivery_receipts ("phoneNumberId", "providerMessageId", recipient, status, "sentAt");
CREATE INDEX whatsapp_delivery_receipts_pending ON whatsapp_delivery_receipts ("phoneNumberId", "providerMessageId", "consumedAt");
CREATE INDEX "whatsapp_delivery_receipts_outboundId_consumedAt_idx" ON whatsapp_delivery_receipts ("outboundId", "consumedAt");
