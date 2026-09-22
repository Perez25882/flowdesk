-- How a shop sells, a plan change that has not landed yet, and the identity of
-- an automatically-raised payment claim.

-- CatalogueMode: a great many Ghanaian SMEs keep no product list at all. The
-- assistant answers from a catalogue when there is one and routes the question
-- to the owner when there is not; this is what tells it which.
CREATE TYPE "CatalogueMode" AS ENUM ('CATALOGUE', 'ENQUIRY_LED');

ALTER TABLE "businesses"
  ADD COLUMN "catalogueMode" "CatalogueMode" NOT NULL DEFAULT 'CATALOGUE',
  ADD COLUMN "pendingPlan" "BusinessPlan",
  ADD COLUMN "planChangeAt" TIMESTAMP(3),
  ADD COLUMN "pendingPlanKind" TEXT;

-- Existing businesses that have never added a product are almost certainly
-- enquiry-led; they signed up, connected a number and started taking messages.
-- Defaulting them to CATALOGUE would leave the assistant refusing to engage
-- with every product question they get. Businesses WITH products keep the
-- catalogue behaviour they already have.
UPDATE "businesses" b
   SET "catalogueMode" = 'ENQUIRY_LED'
 WHERE NOT EXISTS (
   SELECT 1 FROM "products" p
    WHERE p."businessId" = b."id" AND p."deletedAt" IS NULL
 );

ALTER TABLE "payments" ADD COLUMN "sourceMessageId" TEXT;

-- One claim per inbound image. A read-then-write leaves a window two workers
-- racing the same Meta redelivery can both pass; a constraint does not.
CREATE UNIQUE INDEX "payments_businessId_sourceMessageId_key"
  ON "payments"("businessId", "sourceMessageId");

CREATE INDEX "payments_businessId_screenshotKey_idx"
  ON "payments"("businessId", "screenshotKey");
