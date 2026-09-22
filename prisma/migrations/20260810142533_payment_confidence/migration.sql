CREATE TYPE "PaymentConfidence" AS ENUM ('CLAIMED', 'SELLER_ATTESTED', 'TELCO_MATCHED', 'GATEWAY_CONFIRMED');
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

ALTER TABLE "payments"
  ADD COLUMN "confidence" "PaymentConfidence" NOT NULL DEFAULT 'CLAIMED',
  ADD COLUMN "direction"  "PaymentDirection"  NOT NULL DEFAULT 'IN',
  ADD COLUMN "attestedBy" TEXT,
  ADD COLUMN "attestedAt" TIMESTAMP(3),
  ADD COLUMN "voidedAt"   TIMESTAMP(3),
  ADD COLUMN "voidedBy"   TEXT,
  ADD COLUMN "voidReason" TEXT;

-- Every historically verified payment was the owner asserting the money landed,
-- which is exactly SELLER_ATTESTED. Unverified rows were never money, so they
-- keep the CLAIMED default. `verifiedAt` can be null on rows predating the
-- current write path, so fall back to creation time rather than leaving an
-- attested payment with no attestation timestamp.
UPDATE "payments"
SET "confidence" = 'SELLER_ATTESTED',
    "attestedBy" = "verifiedBy",
    "attestedAt" = COALESCE("verifiedAt", "createdAt")
WHERE "verified" = true;

DROP INDEX "payments_businessId_verified_idx";
CREATE INDEX "payments_businessId_confidence_idx" ON "payments"("businessId", "confidence");
CREATE INDEX "payments_businessId_voidedAt_idx" ON "payments"("businessId", "voidedAt");

ALTER TABLE "payments"
  DROP COLUMN "verified",
  DROP COLUMN "verifiedBy",
  DROP COLUMN "verifiedAt";
