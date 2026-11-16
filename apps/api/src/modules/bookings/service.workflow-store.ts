import type { Prisma, Workflow } from '@prisma/client';
import { day, definition } from '../workflows/workflow.contract.js';

export const manualServiceSource = 'manual-service:';

export async function recordManualServiceWorkflow(tx: Prisma.TransactionClient, scope: { businessId: string; customerId: string },
  resourceId: string, now: Date, appointmentId?: string): Promise<Workflow> {
  const sourceId = manualServiceSource + resourceId;
  return tx.workflow.create({ data: { businessId: scope.businessId, customerId: scope.customerId,
    sourceId, correlationKey: sourceId, ...(appointmentId ? { appointmentId } : {}),
    definition, version: 4, policyRevision: 0, state: 'RUNNING', operator: 'BOOKINGS', reason: 'STAFF_SERVICE_REQUEST',
    dueAt: now, deadlineAt: new Date(+now + 120 * day), evidence: { create: {
      eventKey: sourceId, eventType: 'SERVICE_PROGRESS', state: 'RUNNING', operator: 'BOOKINGS',
      reason: 'STAFF_SERVICE_REQUEST', facts: { resourceId, appointmentId: appointmentId ?? null },
    } },
  } });
}
