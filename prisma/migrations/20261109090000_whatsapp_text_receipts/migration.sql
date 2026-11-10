CREATE TYPE "WhatsAppTextReceiptStatus" AS ENUM (
    'PENDING', 'WAITING_MAPPING', 'WAITING_QUEUE', 'FAILED', 'COMPLETED'
);

CREATE TABLE "whatsapp_text_receipts" (
    "id" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "businessId" TEXT,
    "sender" TEXT,
    "profileName" TEXT,
    "body" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "replyToWaId" TEXT,
    "status" "WhatsAppTextReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "messageId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "whatsapp_text_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_text_receipts_businessId_fkey"
        FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "whatsapp_text_receipts_messageId_fkey"
        FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "whatsapp_text_receipts_phoneNumberId_waMessageId_key"
    ON "whatsapp_text_receipts"("phoneNumberId", "waMessageId");
CREATE UNIQUE INDEX "whatsapp_text_receipts_messageId_key"
    ON "whatsapp_text_receipts"("messageId");
CREATE INDEX "whatsapp_text_receipts_nextAttemptAt_id_idx"
    ON "whatsapp_text_receipts"("nextAttemptAt", "id");
CREATE INDEX "whatsapp_text_receipts_finishedAt_idx"
    ON "whatsapp_text_receipts"("finishedAt");
CREATE INDEX "whatsapp_text_receipts_businessId_status_idx"
    ON "whatsapp_text_receipts"("businessId", "status");
