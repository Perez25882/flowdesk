import type { Prisma, Workflow } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { explicitOrderRequest, hasPolicyOverride } from '../../services/assistant/commitment.js';
import { allowsTransition, day, definition, pinnedDefinition, type BusinessEvent } from './workflow.contract.js';

export async function admitWorkflow(
  tx: Prisma.TransactionClient,
  identity: { businessId: string; customerId: string; messageId: string; receiptId: string; phoneNumberId: string;
    body: string | null; replyTo: string | null },
  now: Date,
): Promise<boolean> {
  const { businessId, customerId, messageId, receiptId } = identity;
  const policy = await tx.workflowSettings.findUnique({ where: { businessId } });
  if (!policy?.enabled) return false;
  const services = ['APPOINTMENT', 'PROFESSIONAL_SERVICES'].includes(policy.profile) && await tx.serviceBusinessSettings.findUnique({
    where: { businessId, enabled: true }, select: { businessId: true },
  });
  const commerce = ['ONLINE_RETAIL', 'CUSTOM_ORDER'].includes(policy.profile) && await tx.commercePolicy.findUnique({
    where: { businessId, enabled: true }, select: { businessId: true },
  });
  const correlationKey = 'whatsapp:' + receiptId;
  if (!services && identity.body && identity.replyTo && explicitOrderRequest(identity.body) && !hasPolicyOverride(identity.body)) {
    const [quote] = await tx.$queryRaw<Array<{ id: string; definition: string; version: number }>>`
      SELECT w.id, w.definition, w.version FROM workflows w
      JOIN whatsapp_sends s ON s."businessId" = w."businessId" AND s."eventKey" = 'assistant-reply-' || w."sourceId"
      WHERE w."businessId" = ${businessId} AND w."customerId" = ${customerId} AND s."providerMessageId" = ${identity.replyTo}
        AND s."phoneNumberId" = ${identity.phoneNumberId} AND s.payload->>'customerId' = ${customerId}
        AND w."policyRevision" = ${policy.revision} AND w."actionSourceId" IS NULL AND w."deadlineAt" > ${now}
        AND w.state IN ('READY', 'WAITING_PROVIDER', 'WAITING_CUSTOMER')
        AND EXISTS(SELECT 1 FROM workflow_evidence e WHERE e."workflowId" = w.id AND e."eventType" = 'SALES_QUOTE')
      LIMIT 1 FOR UPDATE OF w
    `;
    if (quote && pinnedDefinition(quote.definition, quote.version)) {
      await tx.workflow.update({ where: { id: quote.id }, data: { actionSourceId: messageId, sendId: null,
        state: 'RUNNING', operator: 'SALES', reason: 'PURCHASE_RECEIVED', dueAt: now, deadlineAt: new Date(+now + day),
        revision: { increment: 1 }, evidence: { create: {
          eventKey: correlationKey, eventType: 'WHATSAPP_INBOUND', state: 'RUNNING', operator: 'SALES',
          reason: 'PURCHASE_RECEIVED', facts: { receiptId, messageId, customerId },
        } } } });
      return false;
    }
  }
  await tx.workflow.create({
    data: {
      businessId, customerId, sourceId: messageId, correlationKey, definition,
      version: services ? 4 : commerce ? 3 : Number(env.WORKFLOW_DEFINITION_VERSION),
      policyRevision: policy.revision, reason: 'AUTHENTICATED_INBOUND', dueAt: now, deadlineAt: new Date(+now + day * (services ? 120 : 1)),
      evidence: { create: {
        eventKey: correlationKey, eventType: 'WHATSAPP_INBOUND', state: 'CREATED', operator: 'CARE',
        reason: 'AUTHENTICATED_INBOUND', facts: { receiptId, messageId, customerId },
      } },
    },
  });
  return Boolean(services);
}

export async function lockWorkflow(tx: Prisma.TransactionClient, businessId: string, id: string): Promise<Workflow> {
  const [row] = await tx.$queryRaw<Workflow[]>`
    SELECT * FROM workflows WHERE id = ${id} AND "businessId" = ${businessId} FOR UPDATE
  `;
  if (!row) throw new NotFoundError('Workflow not found');
  return row;
}

export async function transition(
  tx: Prisma.TransactionClient, row: Workflow, event: BusinessEvent, dueAt: Date | null,
): Promise<void> {
  if (!allowsTransition(row.definition, row.version, row.state, event)) throw new ConflictError('Invalid workflow transition');
  const saved = await tx.workflowEvidence.createMany({
    data: {
      workflowId: row.id, businessId: row.businessId, eventKey: event.key, eventType: event.type,
      state: event.state, operator: event.operator, reason: event.reason, facts: event.facts ?? {},
    },
    skipDuplicates: true,
  });
  await tx.workflow.update({
    where: { id: row.id },
    data: saved.count === 0 ? { dueAt } : {
      state: event.state, operator: event.operator, reason: event.reason, dueAt,
      revision: { increment: 1 }, ...event.links,
      ...(event.deadlineAt ? { deadlineAt: event.deadlineAt } : {}),
    },
  });
}

export async function runDueWorkflow(
  now: Date, advance: (tx: Prisma.TransactionClient, row: Workflow, now: Date) => Promise<void>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Workflow[]>`
      SELECT * FROM workflows WHERE "dueAt" <= ${now}
      ORDER BY "dueAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!row) return false;
    await advance(tx, row, now);
    return true;
  }, { maxWait: 2_000, timeout: 5_000 });
}
