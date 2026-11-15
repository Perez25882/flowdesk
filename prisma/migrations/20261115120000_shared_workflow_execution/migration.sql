-- CreateEnum
BEGIN;

CREATE TYPE "WorkflowState" AS ENUM ('CREATED', 'READY', 'RUNNING', 'WAITING_CUSTOMER', 'WAITING_OWNER_APPROVAL', 'WAITING_STAFF', 'WAITING_PROVIDER', 'RETRY_SCHEDULED', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowOperator" AS ENUM ('SALES', 'BOOKINGS', 'PAYMENTS', 'FULFILLMENT', 'CARE');

-- CreateTable
CREATE TABLE "workflow_settings" (
    "businessId" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "supportMode" TEXT NOT NULL DEFAULT 'OWNER_REVIEW',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_settings_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "actionSourceId" TEXT,
    "correlationKey" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "state" "WorkflowState" NOT NULL DEFAULT 'CREATED',
    "operator" "WorkflowOperator" NOT NULL DEFAULT 'CARE',
    "reason" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "recoveryCount" INTEGER NOT NULL DEFAULT 0,
    "orderId" TEXT,
    "appointmentId" TEXT,
    "sendId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_evidence" (
    "id" BIGSERIAL NOT NULL,
    "workflowId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "state" "WorkflowState" NOT NULL,
    "operator" "WorkflowOperator" NOT NULL,
    "reason" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_approvals" (
    "workflowId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "evidenceKey" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_approvals_pkey" PRIMARY KEY ("workflowId")
);

-- CreateIndex
CREATE INDEX "workflows_dueAt_idx" ON "workflows"("dueAt");

-- CreateIndex
CREATE INDEX "workflows_businessId_createdAt_id_idx" ON "workflows"("businessId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_businessId_sourceId_key" ON "workflows"("businessId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_businessId_actionSourceId_key" ON "workflows"("businessId", "actionSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_businessId_correlationKey_key" ON "workflows"("businessId", "correlationKey");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_id_businessId_key" ON "workflows"("id", "businessId");

-- CreateIndex
CREATE INDEX "workflow_evidence_workflowId_id_idx" ON "workflow_evidence"("workflowId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_evidence_workflowId_eventKey_key" ON "workflow_evidence"("workflowId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_approvals_workflowId_businessId_key" ON "workflow_approvals"("workflowId", "businessId");

-- AddForeignKey
ALTER TABLE "workflow_settings" ADD CONSTRAINT "workflow_settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId") REFERENCES "customers"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_evidence" ADD CONSTRAINT "workflow_evidence_workflowId_businessId_fkey" FOREIGN KEY ("workflowId", "businessId") REFERENCES "workflows"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_workflowId_businessId_fkey" FOREIGN KEY ("workflowId", "businessId") REFERENCES "workflows"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "workflow_settings"
  ADD CONSTRAINT "workflow_settings_profile_check" CHECK ("profile" IN ('ONLINE_RETAIL', 'CUSTOM_ORDER', 'APPOINTMENT', 'PROFESSIONAL_SERVICES')),
  ADD CONSTRAINT "workflow_settings_support_mode_check" CHECK ("supportMode" IN ('OWNER_REVIEW', 'VERIFIED_STATUS')),
  ADD CONSTRAINT "workflow_settings_revision_check" CHECK ("revision" > 0);

ALTER TABLE "workflows"
  ADD CONSTRAINT "workflow_terminal_schedule_check" CHECK ("state" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR "dueAt" IS NULL),
  ADD CONSTRAINT "workflow_revision_check" CHECK ("version" > 0 AND "policyRevision" > 0 AND "revision" >= 0 AND "recoveryCount" BETWEEN 0 AND 3);

ALTER TABLE "workflow_approvals"
  ADD CONSTRAINT "workflow_approval_decision_check" CHECK (
    ("decision" IS NULL AND "decidedAt" IS NULL AND "executedAt" IS NULL) OR
    ("decision" = 'REJECTED' AND "decidedAt" IS NOT NULL AND "executedAt" IS NULL) OR
    ("decision" = 'APPROVED' AND "decidedAt" IS NOT NULL)
  );

COMMIT;
