BEGIN;

CREATE TYPE "CommerceInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

ALTER TABLE commerce_invoices
  ALTER COLUMN "orderId" DROP NOT NULL,
  ADD COLUMN status "CommerceInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
  ADD COLUMN terms TEXT,
  ADD CONSTRAINT "commerce_invoices_customerId_businessId_fkey"
    FOREIGN KEY ("customerId", "businessId") REFERENCES customers (id, "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "commerce_invoices_id_businessId_customerId_key" ON commerce_invoices (id, "businessId", "customerId");

ALTER TABLE payments ADD COLUMN "invoiceId" TEXT,
  ADD CONSTRAINT "payments_invoiceId_businessId_customerId_fkey" FOREIGN KEY ("invoiceId", "businessId", "customerId")
    REFERENCES commerce_invoices (id, "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE payment_requests ADD COLUMN "invoiceId" TEXT,
  ADD CONSTRAINT "payment_requests_invoiceId_businessId_customerId_fkey" FOREIGN KEY ("invoiceId", "businessId", "customerId")
    REFERENCES commerce_invoices (id, "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE paystack_initializations ADD COLUMN "invoiceId" TEXT,
  ADD CONSTRAINT "paystack_initializations_invoiceId_businessId_customerId_fkey" FOREIGN KEY ("invoiceId", "businessId", "customerId")
    REFERENCES commerce_invoices (id, "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "payments_businessId_invoiceId_idx" ON payments ("businessId", "invoiceId");
CREATE INDEX "payment_requests_businessId_invoiceId_idx" ON payment_requests ("businessId", "invoiceId");
CREATE INDEX "paystack_initializations_businessId_invoiceId_state_idx" ON paystack_initializations ("businessId", "invoiceId", state);

CREATE FUNCTION enforce_commerce_invoice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."businessId", NEW."customerId", NEW."orderId", NEW.reference) IS DISTINCT FROM
     (OLD.id, OLD."businessId", OLD."customerId", OLD."orderId", OLD.reference) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invoice identity is immutable';
  END IF;
  IF OLD.status <> 'DRAFT' AND
     (NEW."receiptLines", NEW.total, NEW.deposit, NEW."releaseThreshold", NEW.currency, NEW."dueAt", NEW."issuedAt", NEW.terms)
      IS DISTINCT FROM
     (OLD."receiptLines", OLD.total, OLD.deposit, OLD."releaseThreshold", OLD.currency, OLD."dueAt", OLD."issuedAt", OLD.terms) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Issued invoice terms are immutable';
  END IF;
  IF (OLD.status = 'ISSUED' AND NEW.status = 'DRAFT') OR (OLD.status = 'CANCELLED' AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid invoice transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_invoice_identity BEFORE UPDATE ON commerce_invoices
  FOR EACH ROW EXECUTE FUNCTION enforce_commerce_invoice_identity();

CREATE FUNCTION enforce_financial_invoice_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Financial invoice allocation is immutable';
    END IF;
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    PERFORM 1 FROM commerce_invoices i WHERE i.id = NEW."invoiceId" AND i."businessId" = NEW."businessId"
      AND i."customerId" = NEW."customerId" AND i."orderId" IS NOT DISTINCT FROM NEW."orderId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Financial invoice relationship disagrees';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_invoice_scope BEFORE INSERT OR UPDATE OF "invoiceId", "businessId", "customerId", "orderId" ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_financial_invoice_scope();
CREATE TRIGGER request_invoice_scope BEFORE INSERT OR UPDATE OF "invoiceId", "businessId", "customerId", "orderId" ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_financial_invoice_scope();
CREATE TRIGGER initialization_invoice_scope BEFORE INSERT OR UPDATE OF "invoiceId", "businessId", "customerId", "orderId" ON paystack_initializations
  FOR EACH ROW EXECUTE FUNCTION enforce_financial_invoice_scope();

CREATE FUNCTION enforce_checkout_invoice_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_requests' THEN
    IF NEW."paymentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM payments p WHERE p.id = NEW."paymentId" AND p."invoiceId" IS NOT DISTINCT FROM NEW."invoiceId"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Request and payment invoice disagree';
    END IF;
  ELSIF NEW."requestId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_requests r WHERE r.id = NEW."requestId" AND r.reference = NEW.reference
      AND r."businessId" = NEW."businessId" AND r."customerId" = NEW."customerId"
      AND r."orderId" IS NOT DISTINCT FROM NEW."orderId" AND r."invoiceId" IS NOT DISTINCT FROM NEW."invoiceId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Initialization and request invoice disagree';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_invoice_link BEFORE INSERT OR UPDATE OF "paymentId", "invoiceId" ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_checkout_invoice_link();
CREATE TRIGGER initialization_invoice_link BEFORE INSERT OR UPDATE OF "requestId", "invoiceId" ON paystack_initializations
  FOR EACH ROW EXECUTE FUNCTION enforce_checkout_invoice_link();

CREATE FUNCTION enforce_settlement_invoice_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payment_requests r JOIN payments p ON p.id = NEW."paymentId"
    WHERE r.id = NEW."requestId" AND (r."invoiceId" IS NOT NULL OR p."invoiceId" IS NOT NULL)
      AND (r."invoiceId" IS DISTINCT FROM p."invoiceId" OR r."paymentId" IS DISTINCT FROM p.id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Settlement and payment invoice disagree';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_invoice_link BEFORE INSERT OR UPDATE OF "requestId", "paymentId" ON paystack_settlements
  FOR EACH ROW EXECUTE FUNCTION enforce_settlement_invoice_link();

COMMIT;
