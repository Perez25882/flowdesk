BEGIN;

-- CreateEnum
CREATE TYPE "CommerceProductMode" AS ENUM ('TRACKED', 'MADE_TO_ORDER', 'SERVICE');

-- CreateEnum
CREATE TYPE "CommerceQuoteState" AS ENUM ('DRAFT', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CommerceDeliveryMode" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "CommercePreparationState" AS ENUM ('PREPARING', 'READY', 'COLLECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommerceCaseKind" AS ENUM ('COMPLAINT', 'CANCELLATION', 'RETURN', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "CommerceCaseState" AS ENUM ('OPEN', 'ASSIGNED', 'WAITING', 'ESCALATED', 'RESOLVED');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "commerceConsentAt" TIMESTAMP(3),
ADD COLUMN     "commerceConsentId" TEXT,
ADD COLUMN     "commerceFollowup" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "commerceMode" "CommerceProductMode" NOT NULL DEFAULT 'TRACKED',
ADD COLUMN     "variantLabel" TEXT,
ADD COLUMN     "variantOfId" TEXT;

-- CreateTable
CREATE TABLE "commerce_policies" (
    "businessId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowPickup" BOOLEAN NOT NULL DEFAULT true,
    "allowDelivery" BOOLEAN NOT NULL DEFAULT false,
    "quoteMinutes" INTEGER NOT NULL DEFAULT 30,
    "invoiceDays" INTEGER NOT NULL DEFAULT 7,
    "depositPercent" INTEGER NOT NULL DEFAULT 0,
    "releaseOnDeposit" BOOLEAN NOT NULL DEFAULT false,
    "allowFollowup" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_policies_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "commerce_quotes" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "sourceId" TEXT,
    "acceptanceMessageId" TEXT,
    "orderId" TEXT,
    "state" "CommerceQuoteState" NOT NULL,
    "deliveryMode" "CommerceDeliveryMode" NOT NULL,
    "address" TEXT,
    "specification" TEXT,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "policyRevision" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_quote_lines" (
    "quoteId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "productMode" "CommerceProductMode" NOT NULL,
    "listPrice" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "commerce_quote_lines_pkey" PRIMARY KEY ("quoteId","productId")
);

-- CreateTable
CREATE TABLE "commerce_invoices" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "receiptLines" JSONB NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "deposit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "releaseThreshold" DECIMAL(12,2) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_preparations" (
    "invoiceId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "state" "CommercePreparationState" NOT NULL DEFAULT 'PREPARING',
    "assignedStaffId" TEXT,
    "madeToOrder" BOOLEAN NOT NULL,
    "readyAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_preparations_pkey" PRIMARY KEY ("invoiceId")
);

-- CreateTable
CREATE TABLE "commerce_cases" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "orderId" TEXT,
    "kind" "CommerceCaseKind" NOT NULL,
    "state" "CommerceCaseState" NOT NULL DEFAULT 'OPEN',
    "assignedStaffId" TEXT,
    "resolution" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_case_events" (
    "caseId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" "CommerceCaseState" NOT NULL,
    "staffId" TEXT,
    "resolution" TEXT,
    "evidenceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_case_events_pkey" PRIMARY KEY ("caseId","revision")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_quotes_acceptanceMessageId_key" ON "commerce_quotes"("acceptanceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_quotes_orderId_key" ON "commerce_quotes"("orderId");

-- CreateIndex
CREATE INDEX "commerce_quotes_state_expiresAt_idx" ON "commerce_quotes"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "commerce_quotes_businessId_createdAt_idx" ON "commerce_quotes"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_quotes_businessId_requestKey_key" ON "commerce_quotes"("businessId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_quotes_id_businessId_key" ON "commerce_quotes"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_quotes_orderId_businessId_customerId_key" ON "commerce_quotes"("orderId", "businessId", "customerId");

-- CreateIndex
CREATE INDEX "commerce_quote_lines_businessId_productId_idx" ON "commerce_quote_lines"("businessId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_invoices_orderId_key" ON "commerce_invoices"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_invoices_businessId_reference_key" ON "commerce_invoices"("businessId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_invoices_orderId_businessId_customerId_key" ON "commerce_invoices"("orderId", "businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_invoices_id_businessId_key" ON "commerce_invoices"("id", "businessId");

-- CreateIndex
CREATE INDEX "commerce_preparations_businessId_state_idx" ON "commerce_preparations"("businessId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_preparations_invoiceId_businessId_key" ON "commerce_preparations"("invoiceId", "businessId");

-- CreateIndex
CREATE INDEX "commerce_cases_businessId_state_createdAt_idx" ON "commerce_cases"("businessId", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_cases_businessId_sourceId_key" ON "commerce_cases"("businessId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_cases_id_businessId_key" ON "commerce_cases"("id", "businessId");

-- CreateIndex
CREATE INDEX "products_variantOfId_businessId_idx" ON "products"("variantOfId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "products_id_businessId_key" ON "products"("id", "businessId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_variantOfId_businessId_fkey" FOREIGN KEY ("variantOfId", "businessId") REFERENCES "products"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_policies" ADD CONSTRAINT "commerce_policies_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId") REFERENCES "customers"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_orderId_businessId_customerId_fkey" FOREIGN KEY ("orderId", "businessId", "customerId") REFERENCES "orders"("id", "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_quote_lines" ADD CONSTRAINT "commerce_quote_lines_quoteId_businessId_fkey" FOREIGN KEY ("quoteId", "businessId") REFERENCES "commerce_quotes"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_quote_lines" ADD CONSTRAINT "commerce_quote_lines_productId_businessId_fkey" FOREIGN KEY ("productId", "businessId") REFERENCES "products"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_orderId_businessId_customerId_fkey" FOREIGN KEY ("orderId", "businessId", "customerId") REFERENCES "orders"("id", "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_preparations" ADD CONSTRAINT "commerce_preparations_invoiceId_businessId_fkey" FOREIGN KEY ("invoiceId", "businessId") REFERENCES "commerce_invoices"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_cases" ADD CONSTRAINT "commerce_cases_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId") REFERENCES "customers"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_cases" ADD CONSTRAINT "commerce_cases_orderId_businessId_customerId_fkey" FOREIGN KEY ("orderId", "businessId", "customerId") REFERENCES "orders"("id", "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_case_events" ADD CONSTRAINT "commerce_case_events_caseId_businessId_fkey" FOREIGN KEY ("caseId", "businessId") REFERENCES "commerce_cases"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "products"
  ADD CONSTRAINT "products_commerce_variant_pair" CHECK (("variantOfId" IS NULL) = ("variantLabel" IS NULL)),
  ADD CONSTRAINT "products_commerce_physical_stock" CHECK ("commerceMode" = 'TRACKED' OR "stockQuantity" = 0);
ALTER TABLE "commerce_policies"
  ADD CONSTRAINT "commerce_policy_limits" CHECK ("quoteMinutes" BETWEEN 5 AND 1440 AND "invoiceDays" BETWEEN 1 AND 90
    AND "depositPercent" BETWEEN 0 AND 90 AND (NOT "releaseOnDeposit" OR "depositPercent" > 0) AND ("allowPickup" OR "allowDelivery"));
ALTER TABLE "commerce_quotes"
  ADD CONSTRAINT "commerce_quote_amount" CHECK ("total" > 0 AND "currency" = 'GHS'),
  ADD CONSTRAINT "commerce_quote_delivery_address" CHECK (("deliveryMode" = 'DELIVERY') = (address IS NOT NULL));
ALTER TABLE "commerce_quote_lines"
  ADD CONSTRAINT "commerce_quote_valid_line" CHECK (quantity BETWEEN 1 AND 1000 AND "unitPrice" > 0 AND "listPrice" > 0);
ALTER TABLE "commerce_invoices"
  ADD CONSTRAINT "commerce_invoice_amounts" CHECK ("total" > 0 AND "currency" = 'GHS' AND "deposit" >= 0 AND "deposit" <= "total"
    AND "releaseThreshold" > 0 AND "releaseThreshold" <= "total");
ALTER TABLE "commerce_preparations"
  ADD CONSTRAINT "commerce_pickup_evidence" CHECK ("state" <> 'COLLECTED' OR "collectedAt" IS NOT NULL);
COMMIT;
