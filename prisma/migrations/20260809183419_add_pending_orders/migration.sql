-- CreateEnum
CREATE TYPE "PendingOrderStatus" AS ENUM ('AWAITING_REPLY', 'RESOLVED', 'EXPIRED', 'ABANDONED');

-- CreateTable
CREATE TABLE "pending_orders" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "draftItems" JSONB NOT NULL DEFAULT '[]',
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clarificationCount" INTEGER NOT NULL DEFAULT 0,
    "lastQuestion" TEXT,
    "status" "PendingOrderStatus" NOT NULL DEFAULT 'AWAITING_REPLY',
    "sourceMessageId" TEXT,
    "resolvedOrderId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_orders_businessId_status_updatedAt_idx" ON "pending_orders"("businessId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One open pending order per customer.
--
-- Prisma cannot express a partial unique index, so it is written by hand. It is
-- the only thing that actually stops two concurrent inbound messages each
-- creating a draft for the same conversation: the Redis mutex in the service
-- layer makes that rare, but a mutex is an optimisation and this is the
-- guarantee. Scoped with WHERE so resolved and expired rows accumulate freely.
CREATE UNIQUE INDEX "pending_orders_one_open_per_customer"
  ON "pending_orders"("businessId", "customerId")
  WHERE "status" = 'AWAITING_REPLY';
