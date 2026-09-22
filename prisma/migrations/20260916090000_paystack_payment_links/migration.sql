-- CreateEnum
CREATE TYPE "PaymentRequestStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CARD';

-- AlterTable
ALTER TABLE "businesses"
  ADD COLUMN "paystackSubaccountCode" TEXT,
  ADD COLUMN "payoutBankCode" TEXT,
  ADD COLUMN "payoutAccountNumber" TEXT,
  ADD COLUMN "payoutAccountName" TEXT,
  ADD COLUMN "payoutConnectedAt" TIMESTAMP(3),
  ADD COLUMN "commissionPercent" DECIMAL(5,2);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_paystackSubaccountCode_key" ON "businesses"("paystackSubaccountCode");

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "reference" TEXT NOT NULL,
    "authorizationUrl" TEXT NOT NULL,
    "accessCode" TEXT,
    "status" "PaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "channel" TEXT,
    "gatewayFee" DECIMAL(12,2),
    "platformFee" DECIMAL(12,2),
    "subaccountCode" TEXT,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paymentId" TEXT,
    "sentMessageId" TEXT,
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_reference_key" ON "payment_requests"("reference");
CREATE UNIQUE INDEX "payment_requests_paymentId_key" ON "payment_requests"("paymentId");
CREATE INDEX "payment_requests_businessId_status_idx" ON "payment_requests"("businessId", "status");
CREATE INDEX "payment_requests_businessId_customerId_idx" ON "payment_requests"("businessId", "customerId");
CREATE INDEX "payment_requests_businessId_orderId_idx" ON "payment_requests"("businessId", "orderId");
CREATE INDEX "payment_requests_businessId_createdAt_idx" ON "payment_requests"("businessId", "createdAt" DESC);
CREATE INDEX "payment_requests_status_expiresAt_idx" ON "payment_requests"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
