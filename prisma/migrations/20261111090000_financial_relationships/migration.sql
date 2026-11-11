-- Existing identities stay in place. NOT VALID protects new relationships
-- without scanning or changing inconsistent historical rows.
BEGIN;
CREATE UNIQUE INDEX "customers_id_businessId_key" ON "customers"("id", "businessId");
CREATE UNIQUE INDEX "orders_id_businessId_customerId_key" ON "orders"("id", "businessId", "customerId");
CREATE UNIQUE INDEX "payments_id_businessId_customerId_key" ON "payments"("id", "businessId", "customerId");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_customer_tenant_fkey"
    FOREIGN KEY ("customerId", "businessId") REFERENCES "customers"("id", "businessId") NOT VALID,
  ADD CONSTRAINT "payments_order_customer_tenant_fkey"
    FOREIGN KEY ("orderId", "businessId", "customerId") REFERENCES "orders"("id", "businessId", "customerId")
    ON DELETE SET NULL ("orderId") NOT VALID;

ALTER TABLE "payment_requests"
  ADD CONSTRAINT "payment_requests_customer_tenant_fkey"
    FOREIGN KEY ("customerId", "businessId") REFERENCES "customers"("id", "businessId") NOT VALID,
  ADD CONSTRAINT "payment_requests_order_customer_tenant_fkey"
    FOREIGN KEY ("orderId", "businessId", "customerId") REFERENCES "orders"("id", "businessId", "customerId")
    ON DELETE SET NULL ("orderId") NOT VALID,
  ADD CONSTRAINT "payment_requests_payment_customer_tenant_fkey"
    FOREIGN KEY ("paymentId", "businessId", "customerId") REFERENCES "payments"("id", "businessId", "customerId") NOT VALID;

-- MATCH SIMPLE would skip the order field for a no-order link. Check the
-- nullable identity explicitly and protect it on both sides of the link.
CREATE FUNCTION "check_request_payment_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."paymentId" IS NOT NULL THEN
    PERFORM 1 FROM "payments" p
    WHERE p.id = NEW."paymentId" AND p."businessId" = NEW."businessId"
      AND p."customerId" = NEW."customerId" AND p."orderId" IS NOT DISTINCT FROM NEW."orderId"
      AND p.reference = NEW.reference
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Payment request and settlement identity disagree';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_requests_settlement_identity"
BEFORE INSERT OR UPDATE OF "paymentId", "businessId", "customerId", "orderId", "reference" ON "payment_requests"
FOR EACH ROW EXECUTE FUNCTION "check_request_payment_identity"();

CREATE FUNCTION "check_linked_payment_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."orderId", NEW.reference) IS DISTINCT FROM (OLD."orderId", OLD.reference)
     AND EXISTS (SELECT 1 FROM "payment_requests" WHERE "paymentId" = OLD.id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Linked payment order and reference are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_linked_identity"
BEFORE UPDATE OF "orderId", "reference" ON "payments"
FOR EACH ROW EXECUTE FUNCTION "check_linked_payment_identity"();

ALTER TABLE "staff_activity" ALTER COLUMN "staffId" DROP NOT NULL,
  ADD COLUMN "businessId" TEXT,
  ADD CONSTRAINT "staff_activity_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "staff_activity_has_actor" CHECK ("staffId" IS NOT NULL OR "businessId" IS NOT NULL);
CREATE INDEX "staff_activity_businessId_createdAt_idx" ON "staff_activity"("businessId", "createdAt" DESC);
COMMIT;
