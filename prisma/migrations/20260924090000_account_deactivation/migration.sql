-- When the owner pauses their own shop.
--
-- Nullable with no default and no backfill: every existing shop reads as open,
-- which is what they are. Deliberately not expressed as `active = false`,
-- because sign-in refuses an inactive account and the owner has nowhere else to
-- unpause from — that pause would have been permanent.
ALTER TABLE "businesses" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
