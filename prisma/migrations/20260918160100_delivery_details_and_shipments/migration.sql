-- Delivery details as columns.
--
-- Until now an address a customer gave survived only as free text inside
-- orders.rawMessage, which means it could be read by a person and by nothing
-- else: no list of today's deliveries, no address on a waybill, no way to ask
-- "which orders are going to Tema". Dispatch cannot be built on that.
ALTER TABLE "orders"
  ADD COLUMN "recipientName"      TEXT,
  ADD COLUMN "deliveryAddress"    TEXT,
  ADD COLUMN "deliveryArea"       TEXT,
  ADD COLUMN "contactPhone"       TEXT,
  ADD COLUMN "deliveryCapturedAt" TIMESTAMP(3),
  ADD COLUMN "deliveryAsks"       INTEGER NOT NULL DEFAULT 0;

-- The customer's copy is a convenience only: it lets the assistant offer the
-- last address back instead of asking again. The order's own columns stay
-- authoritative, because people do not always send things to the same place.
ALTER TABLE "customers"
  ADD COLUMN "lastRecipientName"   TEXT,
  ADD COLUMN "lastDeliveryAddress" TEXT,
  ADD COLUMN "lastDeliveryArea"    TEXT,
  ADD COLUMN "lastContactPhone"    TEXT;

CREATE TABLE "shipments" (
    "id"               TEXT NOT NULL,
    "businessId"       TEXT NOT NULL,
    "orderId"          TEXT NOT NULL,
    "courier"          TEXT,
    "trackingNumber"   TEXT,
    "proofKey"         TEXT,
    "proofMimeType"    TEXT,
    "proofUploadedAt"  TIMESTAMP(3),
    "dispatchedAt"     TIMESTAMP(3),
    "deliveredAt"      TIMESTAMP(3),
    "notes"            TEXT,
    "createdByStaffId" TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- One live shipment per order, enforced here rather than in application code,
-- so "where is my order" can never have two answers.
CREATE UNIQUE INDEX "shipments_orderId_key" ON "shipments"("orderId");
CREATE INDEX "shipments_businessId_idx" ON "shipments"("businessId");
CREATE INDEX "shipments_businessId_dispatchedAt_idx" ON "shipments"("businessId", "dispatchedAt" DESC);
CREATE INDEX "shipments_businessId_trackingNumber_idx" ON "shipments"("businessId", "trackingNumber");

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_createdByStaffId_fkey"
  FOREIGN KEY ("createdByStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A proof photo and the time it was uploaded are one fact, not two. Letting
-- them disagree would give the dashboard a "proof uploaded" state with nothing
-- to show, which is worse than no proof at all.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_proof_complete"
  CHECK (("proofKey" IS NULL) = ("proofUploadedAt" IS NULL));

-- Nothing arrives before it leaves.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivered_after_dispatched"
  CHECK ("deliveredAt" IS NULL OR ("dispatchedAt" IS NOT NULL AND "deliveredAt" >= "dispatchedAt"));
