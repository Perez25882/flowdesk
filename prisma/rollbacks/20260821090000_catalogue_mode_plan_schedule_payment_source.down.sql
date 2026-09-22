DROP INDEX IF EXISTS "payments_businessId_screenshotKey_idx";
DROP INDEX IF EXISTS "payments_businessId_sourceMessageId_key";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "sourceMessageId";
ALTER TABLE "businesses"
  DROP COLUMN IF EXISTS "pendingPlanKind",
  DROP COLUMN IF EXISTS "planChangeAt",
  DROP COLUMN IF EXISTS "pendingPlan",
  DROP COLUMN IF EXISTS "catalogueMode";
DROP TYPE IF EXISTS "CatalogueMode";
