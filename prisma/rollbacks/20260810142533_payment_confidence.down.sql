-- Rollback for migration 20260810142533_payment_confidence.
--
-- Prisma has no down migrations, so this is applied by hand. It is here because
-- the forward migration DROPS three columns: once it lands, the previous
-- application build cannot serve a single payment query, and composing the
-- reversal under outage pressure is not a plan.
--
-- ============================================================================
-- READ THIS BEFORE RUNNING IT. Rolling back is LOSSY.
-- ============================================================================
--
-- The forward migration is information-preserving. This one is not. Three
-- things are destroyed and cannot be recovered from the old schema:
--
--   1. REFUNDS BECOME RECEIPTS. The old schema has no `direction`. Every
--      refund (direction = 'OUT') collapses into an ordinary payment, and the
--      old code adds it to revenue instead of subtracting it. Every affected
--      customer's balance and totalSpend silently inflates by twice the refund.
--      -> If ANY refund has been recorded, prefer fixing forward. Check first:
--           SELECT count(*) FROM "payments" WHERE "direction" = 'OUT';
--         A non-zero result means rolling back corrupts balances.
--
--   2. VOID REASONS ARE ERASED. `voidedAt`, `voidedBy` and `voidReason` have
--      nowhere to go. A voided payment maps to verified = false, which gets the
--      money right, but the record of who reversed it and why — the whole point
--      of this feature — is gone. In a live dispute that is the evidence.
--
--   3. TIER DETAIL FLATTENS. TELCO_MATCHED and GATEWAY_CONFIRMED both become
--      verified = true, indistinguishable from a bare seller attestation.
--
-- Money itself is preserved: `verified` is derived so that exactly the rows the
-- new code counts as money are the rows the old code counts as money.
-- `Order.amountPaid` and `Customer.totalSpend` stay consistent without
-- recomputation, EXCEPT where refunds exist — see (1).
--
-- ============================================================================
-- DEPLOY NOTES FOR THE FORWARD MIGRATION
-- ============================================================================
--
-- * Deploy stop-the-world, not rolling. The moment this migration commits, any
--   still-running old instance fails every payment query — it selects columns
--   that no longer exist. Take the API down, migrate, bring it up on the new
--   build.
--
-- * Lock duration. `ADD COLUMN ... NOT NULL DEFAULT '<enum literal>'` is a
--   PG 11+ fast default (catalog only, no rewrite), but the full-table UPDATE
--   and the two non-concurrent CREATE INDEX share the migration's transaction,
--   so the ACCESS EXCLUSIVE lock from the first ALTER is held across all of it.
--   `payments` is unreadable and unwritable for the duration: seconds at tens
--   of thousands of rows, minutes at millions. Size it against production
--   before scheduling the window.
--
-- * Prisma wraps the file in one transaction, so it either fully applies or
--   fully rolls back. There is no half-migrated state to recover from.
--
-- ============================================================================
-- VERIFIED, not assumed. Applied to a scratch database seeded with one payment
-- of every tier and direction. Result:
--
--   SELLER_ATTESTED  IN               -> verified = true    correct
--   GATEWAY_CONFIRMED IN              -> verified = true    correct
--   CLAIMED          IN               -> verified = false   correct
--   SELLER_ATTESTED  IN, voided       -> verified = false   correct
--   SELLER_ATTESTED  OUT (a refund)   -> verified = TRUE    <- hazard (1), real
--
-- Old columns restored, all seven new columns dropped, both enum types dropped,
-- the _prisma_migrations row removed. The refund row is the documented data
-- loss, observed rather than predicted: it comes back as an ordinary receipt.
-- ============================================================================

BEGIN;

ALTER TABLE "payments"
  ADD COLUMN "verified"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verifiedBy" TEXT,
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- The inverse of the forward backfill. `verified` must mean exactly what the
-- new code means by "counts as money": at or above SELLER_ATTESTED, and not
-- voided. CLAIMED is the only tier below SELLER_ATTESTED, so `<> 'CLAIMED'`
-- expresses that today — revisit this line if a weaker tier is ever added.
UPDATE "payments"
SET "verified"   = ("confidence" <> 'CLAIMED' AND "voidedAt" IS NULL),
    "verifiedBy" = "attestedBy",
    "verifiedAt" = "attestedAt";

DROP INDEX "payments_businessId_confidence_idx";
DROP INDEX "payments_businessId_voidedAt_idx";
CREATE INDEX "payments_businessId_verified_idx" ON "payments"("businessId", "verified");

ALTER TABLE "payments"
  DROP COLUMN "confidence",
  DROP COLUMN "direction",
  DROP COLUMN "attestedBy",
  DROP COLUMN "attestedAt",
  DROP COLUMN "voidedAt",
  DROP COLUMN "voidedBy",
  DROP COLUMN "voidReason";

DROP TYPE "PaymentConfidence";
DROP TYPE "PaymentDirection";

-- Without this, Prisma reports the migration as applied against a schema that
-- no longer has it, and every subsequent `migrate deploy` fails on drift.
DELETE FROM "_prisma_migrations"
WHERE "migration_name" = '20260810142533_payment_confidence';

COMMIT;

-- After running: redeploy the application build from the commit immediately
-- before 6abef30, and run `prisma generate` so the client matches the schema.
