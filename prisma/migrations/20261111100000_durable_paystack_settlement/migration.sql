BEGIN;
-- CreateEnum
CREATE TYPE "PaystackReceiptState" AS ENUM ('PENDING', 'PROCESSING', 'WAITING', 'SETTLED', 'REVIEW');

-- CreateEnum
CREATE TYPE "PaystackInitializationState" AS ENUM ('INITIALIZING', 'CREATED', 'REVIEW', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PaystackNotificationState" AS ENUM ('PENDING', 'SENDING', 'HANDED_OFF', 'SUPPRESSED', 'REVIEW');

-- CreateTable
CREATE TABLE "paystack_receipts" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "callbackTransactionId" TEXT,
    "businessId" TEXT,
    "requestId" TEXT,
    "state" "PaystackReceiptState" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "evidence" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "paystack_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paystack_settlements" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "notificationState" "PaystackNotificationState" NOT NULL DEFAULT 'PENDING',
    "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "notificationNextAt" TIMESTAMP(3),
    "notificationLeaseToken" TEXT,
    "notificationLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paystack_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paystack_initializations" (
    "reference" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "subaccountCode" TEXT NOT NULL,
    "state" "PaystackInitializationState" NOT NULL DEFAULT 'INITIALIZING',
    "reason" TEXT,
    "requestId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paystack_initializations_pkey" PRIMARY KEY ("reference")
);

-- CreateIndex
CREATE UNIQUE INDEX "paystack_receipts_eventKey_key" ON "paystack_receipts"("eventKey");

-- CreateIndex
CREATE INDEX "paystack_receipts_state_nextAttemptAt_idx" ON "paystack_receipts"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "paystack_receipts_state_leaseUntil_idx" ON "paystack_receipts"("state", "leaseUntil");

-- CreateIndex
CREATE INDEX "paystack_receipts_businessId_createdAt_idx" ON "paystack_receipts"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "paystack_receipts_reference_idx" ON "paystack_receipts"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "paystack_settlements_transactionId_key" ON "paystack_settlements"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "paystack_settlements_requestId_key" ON "paystack_settlements"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "paystack_settlements_paymentId_key" ON "paystack_settlements"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "paystack_settlements_receiptId_key" ON "paystack_settlements"("receiptId");

-- CreateIndex
CREATE INDEX "paystack_settlements_notificationState_notificationNextAt_idx" ON "paystack_settlements"("notificationState", "notificationNextAt");

-- CreateIndex
CREATE INDEX "paystack_settlements_notificationState_notificationLeaseUnt_idx" ON "paystack_settlements"("notificationState", "notificationLeaseUntil");

-- CreateIndex
CREATE INDEX "paystack_init_relationship_state_idx" ON "paystack_initializations"("businessId", "customerId", "orderId", "amountMinor", "state");

-- CreateIndex
CREATE INDEX "paystack_initializations_state_createdAt_idx" ON "paystack_initializations"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "paystack_receipts" ADD CONSTRAINT "paystack_receipts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paystack_settlements" ADD CONSTRAINT "paystack_settlements_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "payment_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paystack_settlements" ADD CONSTRAINT "paystack_settlements_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paystack_settlements" ADD CONSTRAINT "paystack_settlements_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "paystack_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paystack_initializations" ADD CONSTRAINT "paystack_initializations_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "payments_reference_idx" ON "payments"("reference");
COMMIT;
