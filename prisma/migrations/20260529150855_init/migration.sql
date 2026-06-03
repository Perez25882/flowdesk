-- CreateEnum
CREATE TYPE "BusinessPlan" AS ENUM ('STARTER', 'BUSINESS', 'GROWTH', 'ENTERPRISE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO', 'CASH', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('MANAGER', 'OPERATIONS', 'DELIVERY');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER', 'REACTION', 'BUTTON_REPLY', 'LIST_REPLY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IntentType" AS ENUM ('ORDER', 'PAYMENT', 'INQUIRY', 'STATUS_CHECK', 'COMPLAINT', 'GREETING', 'OTHER', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "ClassificationSource" AS ENUM ('RULE_ENGINE', 'HAIKU', 'MANUAL');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('SALE', 'RESTOCK', 'ADJUSTMENT', 'RETURN');

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "waPhoneNumberId" TEXT,
    "waAccessToken" TEXT,
    "waWebhookVerified" BOOLEAN NOT NULL DEFAULT false,
    "plan" "BusinessPlan" NOT NULL DEFAULT 'STARTER',
    "trialEndsAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "paystackCustomerId" TEXT,
    "paystackSubCode" TEXT,
    "monthlyConvoCount" INTEGER NOT NULL DEFAULT 0,
    "convoCountResetAt" TIMESTAMP(3),
    "monthlyOrderCount" INTEGER NOT NULL DEFAULT 0,
    "orderCountResetAt" TIMESTAMP(3),
    "replyTemplates" JSONB,
    "notifyOnNewOrder" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnLowStock" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnPayment" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "staffId" TEXT,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "waNumber" TEXT NOT NULL,
    "name" TEXT,
    "outstandingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalSpend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "blacklisted" BOOLEAN NOT NULL DEFAULT false,
    "waNumberInvalid" BOOLEAN NOT NULL DEFAULT false,
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastInteractionAt" TIMESTAMP(3),
    "firstOrderAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "rawMessage" TEXT NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "assignedStaffId" TEXT,
    "stockDeducted" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "matchConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "changedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unit" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "stockQuantity" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "reorderThreshold" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "balanceAfter" DECIMAL(10,3) NOT NULL,
    "orderId" TEXT,
    "staffId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "screenshotUrl" TEXT,
    "screenshotKey" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "loggedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "waMessageId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaKey" TEXT,
    "mediaType" TEXT,
    "reactionEmoji" TEXT,
    "reactedToWaId" TEXT,
    "intent" "IntentType" NOT NULL DEFAULT 'UNCLASSIFIED',
    "intentConfidence" DOUBLE PRECISION,
    "classifiedBy" "ClassificationSource",
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "relatedOrderId" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intent_corrections" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "originalIntent" "IntentType" NOT NULL,
    "correctedIntent" "IntentType" NOT NULL,
    "originalSource" "ClassificationSource",
    "originalConfidence" DOUBLE PRECISION,
    "correctedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "passwordHash" TEXT,
    "inviteToken" TEXT,
    "inviteExpiry" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviteAcceptedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_activity" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceType" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "variables" JSONB,
    "targetTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetAll" BOOLEAN NOT NULL DEFAULT false,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_phone_key" ON "businesses"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_waPhoneNumberId_key" ON "businesses"("waPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_paystackCustomerId_key" ON "businesses"("paystackCustomerId");

-- CreateIndex
CREATE INDEX "businesses_phone_idx" ON "businesses"("phone");

-- CreateIndex
CREATE INDEX "businesses_plan_idx" ON "businesses"("plan");

-- CreateIndex
CREATE INDEX "businesses_waPhoneNumberId_idx" ON "businesses"("waPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "sessions_businessId_idx" ON "sessions"("businessId");

-- CreateIndex
CREATE INDEX "sessions_refreshTokenHash_idx" ON "sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "customers_businessId_idx" ON "customers"("businessId");

-- CreateIndex
CREATE INDEX "customers_businessId_waNumber_idx" ON "customers"("businessId", "waNumber");

-- CreateIndex
CREATE INDEX "customers_businessId_lastInteractionAt_idx" ON "customers"("businessId", "lastInteractionAt" DESC);

-- CreateIndex
CREATE INDEX "customers_businessId_outstandingBalance_idx" ON "customers"("businessId", "outstandingBalance");

-- CreateIndex
CREATE INDEX "customers_businessId_blacklisted_idx" ON "customers"("businessId", "blacklisted");

-- CreateIndex
CREATE UNIQUE INDEX "customers_businessId_waNumber_key" ON "customers"("businessId", "waNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_referenceNumber_key" ON "orders"("referenceNumber");

-- CreateIndex
CREATE INDEX "orders_businessId_idx" ON "orders"("businessId");

-- CreateIndex
CREATE INDEX "orders_businessId_status_idx" ON "orders"("businessId", "status");

-- CreateIndex
CREATE INDEX "orders_businessId_createdAt_idx" ON "orders"("businessId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_businessId_customerId_idx" ON "orders"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "orders_businessId_assignedStaffId_idx" ON "orders"("businessId", "assignedStaffId");

-- CreateIndex
CREATE INDEX "orders_referenceNumber_idx" ON "orders"("referenceNumber");

-- CreateIndex
CREATE INDEX "orders_businessId_status_createdAt_idx" ON "orders"("businessId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "order_status_history_orderId_idx" ON "order_status_history"("orderId");

-- CreateIndex
CREATE INDEX "products_businessId_idx" ON "products"("businessId");

-- CreateIndex
CREATE INDEX "products_businessId_active_idx" ON "products"("businessId", "active");

-- CreateIndex
CREATE INDEX "products_businessId_stockQuantity_idx" ON "products"("businessId", "stockQuantity");

-- CreateIndex
CREATE UNIQUE INDEX "products_businessId_sku_key" ON "products"("businessId", "sku");

-- CreateIndex
CREATE INDEX "stock_movements_businessId_idx" ON "stock_movements"("businessId");

-- CreateIndex
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_orderId_idx" ON "stock_movements"("orderId");

-- CreateIndex
CREATE INDEX "payments_businessId_idx" ON "payments"("businessId");

-- CreateIndex
CREATE INDEX "payments_businessId_customerId_idx" ON "payments"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "payments_businessId_orderId_idx" ON "payments"("businessId", "orderId");

-- CreateIndex
CREATE INDEX "payments_businessId_verified_idx" ON "payments"("businessId", "verified");

-- CreateIndex
CREATE INDEX "payments_businessId_createdAt_idx" ON "payments"("businessId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_waMessageId_key" ON "messages"("waMessageId");

-- CreateIndex
CREATE INDEX "messages_businessId_idx" ON "messages"("businessId");

-- CreateIndex
CREATE INDEX "messages_waMessageId_idx" ON "messages"("waMessageId");

-- CreateIndex
CREATE INDEX "messages_businessId_processed_idx" ON "messages"("businessId", "processed");

-- CreateIndex
CREATE INDEX "messages_businessId_requiresReview_idx" ON "messages"("businessId", "requiresReview");

-- CreateIndex
CREATE INDEX "messages_businessId_intent_idx" ON "messages"("businessId", "intent");

-- CreateIndex
CREATE INDEX "messages_businessId_createdAt_idx" ON "messages"("businessId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "messages_businessId_processed_createdAt_idx" ON "messages"("businessId", "processed", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "intent_corrections_businessId_idx" ON "intent_corrections"("businessId");

-- CreateIndex
CREATE INDEX "intent_corrections_originalIntent_correctedIntent_idx" ON "intent_corrections"("originalIntent", "correctedIntent");

-- CreateIndex
CREATE INDEX "intent_corrections_createdAt_idx" ON "intent_corrections"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "staff_inviteToken_key" ON "staff"("inviteToken");

-- CreateIndex
CREATE INDEX "staff_businessId_idx" ON "staff"("businessId");

-- CreateIndex
CREATE INDEX "staff_businessId_active_idx" ON "staff"("businessId", "active");

-- CreateIndex
CREATE INDEX "staff_inviteToken_idx" ON "staff"("inviteToken");

-- CreateIndex
CREATE UNIQUE INDEX "staff_businessId_phone_key" ON "staff"("businessId", "phone");

-- CreateIndex
CREATE INDEX "staff_activity_staffId_idx" ON "staff_activity"("staffId");

-- CreateIndex
CREATE INDEX "staff_activity_staffId_createdAt_idx" ON "staff_activity"("staffId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "staff_activity_resourceType_resourceId_idx" ON "staff_activity"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "broadcasts_businessId_idx" ON "broadcasts"("businessId");

-- CreateIndex
CREATE INDEX "broadcasts_businessId_status_idx" ON "broadcasts"("businessId", "status");

-- CreateIndex
CREATE INDEX "broadcasts_scheduledAt_idx" ON "broadcasts"("scheduledAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_corrections" ADD CONSTRAINT "intent_corrections_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_activity" ADD CONSTRAINT "staff_activity_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
