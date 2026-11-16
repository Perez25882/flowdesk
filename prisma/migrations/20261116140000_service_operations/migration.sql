BEGIN;
-- AlterTable
ALTER TABLE "services" ADD COLUMN     "bookingRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bookingRules" JSONB;

-- CreateTable
CREATE TABLE "service_business_settings" (
    "businessId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL,
    "hours" JSONB NOT NULL,
    "closures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reminderMinutes" INTEGER,
    "followupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "service_business_settings_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "service_resources" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "staffId" TEXT,
    "hours" JSONB,
    "closures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_leads" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceId" TEXT,
    "workflowId" TEXT,
    "serviceId" TEXT,
    "caseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "requirements" TEXT,
    "budgetMinor" INTEGER,
    "preferredAt" TIMESTAMP(3),
    "assignedStaffId" TEXT,
    "followupAt" TIMESTAMP(3),
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_visits" (
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "leadId" TEXT,
    "invoiceId" TEXT,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "approvalRequired" BOOLEAN NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "holdUntil" TIMESTAMP(3),
    "assignedStaffId" TEXT,
    "paymentReviewAt" TIMESTAMP(3),
    "snapshot" JSONB NOT NULL,
    "stageIndex" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "scheduleRevision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "service_visits_pkey" PRIMARY KEY ("appointmentId")
);

-- CreateTable
CREATE TABLE "service_reservations" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "service_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_visit_events" (
    "appointmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "staffId" TEXT,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_visit_events_pkey" PRIMARY KEY ("appointmentId","revision")
);

-- CreateTable
CREATE TABLE "service_visit_notices" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduleRevision" INTEGER NOT NULL,
    "reason" TEXT,
    "sendId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "service_visit_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_resources_businessId_staffId_key" ON "service_resources"("businessId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "service_resources_id_businessId_key" ON "service_resources"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "service_leads_workflowId_key" ON "service_leads"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "service_leads_caseId_key" ON "service_leads"("caseId");

-- CreateIndex
CREATE INDEX "service_leads_businessId_status_createdAt_idx" ON "service_leads"("businessId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "service_leads_businessId_sourceId_key" ON "service_leads"("businessId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "service_visits_leadId_key" ON "service_visits"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "service_visits_invoiceId_key" ON "service_visits"("invoiceId");

-- CreateIndex
CREATE INDEX "service_visits_state_holdUntil_idx" ON "service_visits"("state", "holdUntil");

-- CreateIndex
CREATE INDEX "service_visits_businessId_assignedStaffId_idx" ON "service_visits"("businessId", "assignedStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "service_visits_businessId_requestKey_key" ON "service_visits"("businessId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "service_visits_appointmentId_businessId_key" ON "service_visits"("appointmentId", "businessId");

-- CreateIndex
CREATE INDEX "service_reservations_appointmentId_idx" ON "service_reservations"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "service_visit_notices_sendId_key" ON "service_visit_notices"("sendId");

-- CreateIndex
CREATE INDEX "service_visit_notices_checkedAt_dueAt_idx" ON "service_visit_notices"("checkedAt", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "service_visit_notices_appointmentId_kind_scheduleRevision_key" ON "service_visit_notices"("appointmentId", "kind", "scheduleRevision");

-- AddForeignKey
ALTER TABLE "service_business_settings" ADD CONSTRAINT "service_business_settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_resources" ADD CONSTRAINT "service_resources_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "service_business_settings"("businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "commerce_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "service_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "commerce_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_reservations" ADD CONSTRAINT "service_reservations_appointmentId_businessId_fkey" FOREIGN KEY ("appointmentId", "businessId") REFERENCES "service_visits"("appointmentId", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_reservations" ADD CONSTRAINT "service_reservations_resourceId_businessId_fkey" FOREIGN KEY ("resourceId", "businessId") REFERENCES "service_resources"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visit_events" ADD CONSTRAINT "service_visit_events_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "service_visits"("appointmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visit_notices" ADD CONSTRAINT "service_visit_notices_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "service_visits"("appointmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE customers
  ADD COLUMN "serviceUpdatesId" TEXT, ADD COLUMN "serviceUpdatesAt" TIMESTAMP(3),
  ADD COLUMN "serviceUpdates" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "serviceFollowupId" TEXT, ADD COLUMN "serviceFollowupAt" TIMESTAMP(3),
  ADD COLUMN "serviceFollowup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE service_business_settings
  ADD COLUMN "templateName" TEXT, ADD COLUMN "templateLanguage" TEXT, ADD COLUMN "templateCheckedAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3), ADD COLUMN "approvedWabaId" TEXT, ADD COLUMN "approvedPhoneId" TEXT;
ALTER TABLE service_business_settings ADD CONSTRAINT service_settings_limits CHECK (revision > 0 AND
  ("reminderMinutes" IS NULL OR "reminderMinutes" BETWEEN 15 AND 2880));
ALTER TABLE service_leads ADD CONSTRAINT service_lead_state CHECK (status IN
  ('NEW','QUALIFIED','WAITING','BOOKED','LOST','DECLINED','UNQUALIFIED','CARE'));
ALTER TABLE service_visits ADD CONSTRAINT service_visit_state CHECK (state IN
  ('HELD','CONFIRMED','ACKNOWLEDGED','CHECKED_IN','IN_PROGRESS','BLOCKED','COMPLETED','EXPIRED','CANCELLED','NO_SHOW'));
ALTER TABLE service_visits ADD CONSTRAINT service_visit_hold CHECK ((state = 'HELD') = ("holdUntil" IS NOT NULL));
ALTER TABLE service_reservations ADD CONSTRAINT service_reservation_positive CHECK ("startsAt" < "endsAt");
ALTER TABLE service_reservations ADD CONSTRAINT service_resource_no_overlap EXCLUDE USING gist
  ("resourceId" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("releasedAt" IS NULL);

CREATE FUNCTION guard_managed_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE managed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "bookingRules" IS NOT NULL INTO managed FROM services WHERE id = NEW."serviceId";
  ELSE
    SELECT EXISTS (SELECT 1 FROM service_visits WHERE "appointmentId" = OLD.id) INTO managed;
  END IF;
  IF managed AND current_setting('flowdesk.service_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Managed appointment requires current service authorization';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_managed_appointment_guard BEFORE INSERT OR UPDATE OR DELETE ON appointments
  FOR EACH ROW EXECUTE FUNCTION guard_managed_appointment();

CREATE FUNCTION guard_managed_catalogue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((TG_OP <> 'INSERT' AND OLD."bookingRules" IS NOT NULL)
    OR (TG_OP <> 'DELETE' AND NEW."bookingRules" IS NOT NULL))
    AND current_setting('flowdesk.service_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Managed catalogue requires current service authorization';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_managed_catalogue_guard BEFORE INSERT OR UPDATE OR DELETE ON services
  FOR EACH ROW EXECUTE FUNCTION guard_managed_catalogue();

CREATE FUNCTION guard_service_invoice_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM service_visits WHERE "invoiceId" = OLD.id) AND
    (NEW.id, NEW."businessId", NEW."customerId", NEW."orderId", NEW.status, NEW.total, NEW.deposit, NEW.currency, NEW."receiptLines")
    IS DISTINCT FROM (OLD.id, OLD."businessId", OLD."customerId", OLD."orderId", OLD.status, OLD.total, OLD.deposit, OLD.currency, OLD."receiptLines") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A service invoice must preserve its commitment terms';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_invoice_terms_guard BEFORE UPDATE ON commerce_invoices
  FOR EACH ROW EXECUTE FUNCTION guard_service_invoice_terms();

CREATE FUNCTION guard_service_visit_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."appointmentId", NEW."businessId", NEW."customerId", NEW."leadId", NEW."invoiceId", NEW.snapshot)
      IS DISTINCT FROM (OLD."appointmentId", OLD."businessId", OLD."customerId", OLD."leadId", OLD."invoiceId", OLD.snapshot) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Service commitment identity is immutable';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM appointments a JOIN services s ON s.id = a."serviceId" AND s."businessId" = a."businessId"
    JOIN customers c ON c.id = a."customerId" AND c."businessId" = a."businessId"
    WHERE a.id = NEW."appointmentId" AND a."businessId" = NEW."businessId" AND a."customerId" = NEW."customerId")
    OR (NEW."invoiceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commerce_invoices i WHERE i.id = NEW."invoiceId"
    AND i."businessId" = NEW."businessId" AND i."customerId" = NEW."customerId" AND i."orderId" IS NULL))
    OR (NEW."leadId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_leads l WHERE l.id = NEW."leadId"
    AND l."businessId" = NEW."businessId" AND l."customerId" = NEW."customerId"))
    OR (NEW."assignedStaffId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staff s WHERE s.id = NEW."assignedStaffId"
    AND s."businessId" = NEW."businessId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Service commitment has inconsistent tenant or customer links';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_visit_scope BEFORE INSERT OR UPDATE ON service_visits FOR EACH ROW EXECUTE FUNCTION guard_service_visit_scope();

ALTER TABLE service_leads ADD CONSTRAINT service_lead_customer_scope
  FOREIGN KEY ("customerId", "businessId") REFERENCES customers (id, "businessId") ON DELETE RESTRICT;
CREATE FUNCTION guard_service_lead_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."serviceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM services s WHERE s.id = NEW."serviceId" AND s."businessId" = NEW."businessId"))
    OR (NEW."assignedStaffId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staff s
    WHERE s.id = NEW."assignedStaffId" AND s."businessId" = NEW."businessId"))
    OR (NEW."workflowId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = NEW."workflowId"
    AND w."businessId" = NEW."businessId" AND w."customerId" = NEW."customerId" AND w.version = 4))
    OR (NEW."caseId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commerce_cases c WHERE c.id = NEW."caseId"
    AND c."businessId" = NEW."businessId" AND c."customerId" = NEW."customerId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Lead relationships must belong to the same customer and business';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_lead_scope BEFORE INSERT OR UPDATE ON service_leads FOR EACH ROW EXECUTE FUNCTION guard_service_lead_scope();

COMMIT;
