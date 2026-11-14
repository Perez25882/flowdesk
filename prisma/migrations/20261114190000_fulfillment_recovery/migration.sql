CREATE TABLE fulfillment_tasks (
  id TEXT PRIMARY KEY,
  "businessId" TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "orderId" TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NOTIFY','DELETE_PROOF')),
  subject TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','DONE','FAILED')),
  reason TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "fulfillment_tasks_businessId_orderId_kind_subject_key"
  ON fulfillment_tasks ("businessId", "orderId", kind, subject);
CREATE INDEX "fulfillment_tasks_nextAttemptAt_idx" ON fulfillment_tasks ("nextAttemptAt");
