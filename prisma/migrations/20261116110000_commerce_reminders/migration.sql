BEGIN;
ALTER TABLE customers ADD COLUMN "reminderConsentId" TEXT, ADD COLUMN "reminderConsentAt" TIMESTAMP(3),
  ADD COLUMN "reminderConsent" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE commerce_reminder_policies (
  "businessId" TEXT PRIMARY KEY REFERENCES businesses (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  "intervalDays" INTEGER NOT NULL DEFAULT 3 CHECK ("intervalDays" BETWEEN 1 AND 30),
  "maxReminders" INTEGER NOT NULL DEFAULT 2 CHECK ("maxReminders" BETWEEN 1 AND 3),
  "templateName" TEXT, "templateLanguage" TEXT, "approvedWabaId" TEXT, "approvedPhoneId" TEXT, "approvedAt" TIMESTAMP(3),
  "templateCheckedAt" TIMESTAMP(3)
);
CREATE TABLE commerce_reminders (
  id TEXT PRIMARY KEY,
  "invoiceId" TEXT NOT NULL, "businessId" TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  "sendId" TEXT UNIQUE REFERENCES whatsapp_sends (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'HANDED_OFF', 'CANCELLED')),
  reason TEXT, "dueAt" TIMESTAMP(3) NOT NULL, "nextCheckAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("invoiceId", sequence),
  FOREIGN KEY ("invoiceId", "businessId") REFERENCES commerce_invoices (id, "businessId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "commerce_reminders_status_nextCheckAt_idx" ON commerce_reminders (status, "nextCheckAt");
COMMIT;
