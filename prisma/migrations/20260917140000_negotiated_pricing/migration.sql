-- Negotiated pricing: a floor the assistant may not go below, promotions, and
-- bulk tiers.
--
-- Every column here is nullable or defaulted, so an existing shop is unchanged
-- until its owner sets something. A product with no floorPrice is not
-- negotiable at all, which is the behaviour every shop has today.

ALTER TABLE "products" ADD COLUMN "floorPrice" DECIMAL(12,2);
ALTER TABLE "products" ADD COLUMN "discountPercent" INTEGER;
ALTER TABLE "products" ADD COLUMN "discountLabel" TEXT;
ALTER TABLE "products" ADD COLUMN "discountEndsAt" TIMESTAMP(3);

ALTER TABLE "businesses" ADD COLUMN "bargainingEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "quantity_tiers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "percentOff" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quantity_tiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quantity_tiers_productId_minQuantity_key" ON "quantity_tiers"("productId", "minQuantity");
CREATE INDEX "quantity_tiers_productId_idx" ON "quantity_tiers"("productId");

ALTER TABLE "quantity_tiers" ADD CONSTRAINT "quantity_tiers_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A floor above the list price would let "negotiation" raise the price, and a
-- floor at or below zero would let it give the item away. Enforced in the
-- database because the router trusts this value absolutely.
ALTER TABLE "products" ADD CONSTRAINT "products_floorPrice_sane"
  CHECK ("floorPrice" IS NULL OR ("floorPrice" > 0 AND "floorPrice" <= "price"));

ALTER TABLE "products" ADD CONSTRAINT "products_discountPercent_sane"
  CHECK ("discountPercent" IS NULL OR ("discountPercent" >= 1 AND "discountPercent" <= 90));

ALTER TABLE "quantity_tiers" ADD CONSTRAINT "quantity_tiers_sane"
  CHECK ("minQuantity" >= 2 AND "percentOff" >= 1 AND "percentOff" <= 90);
