import type { Message, OrderStatus, Prisma, Workflow, WorkflowSettings } from '@prisma/client';
import { persistOutboundSend } from '../../queues/outbound.queue.js';
import { hasPolicyOverride } from '../../services/assistant/commitment.js';
import { day, minute, pinnedDefinition, type BusinessEvent } from './workflow.contract.js';

type SupportSource = Pick<Message, 'id' | 'createdAt'>;
type SupportRequest = { reference: string; payment: boolean; exception: boolean };

export function supportRequest(body: string | null, statusIntent: boolean): SupportRequest | null {
  const reference = body?.match(/\bFD-[A-Z0-9]{3,}\b/i)?.[0]?.toUpperCase();
  if (!body || !reference) return null;
  const payment = /\b(payment status|payment received|did my payment|have i paid|has my payment)\b/i.test(body);
  if (!statusIntent && !payment) return null;
  return { reference, payment, exception: hasPolicyOverride(body) };
}

const orderStatuses: Record<OrderStatus, string> = {
  PENDING: 'waiting for confirmation',
  CONFIRMED: 'confirmed',
  PROCESSING: 'being prepared',
  DISPATCHED: 'dispatched',
  FULFILLED: 'delivered',
  CANCELLED: 'cancelled',
};

type SupportEvidence = { id: string; body: string; key: string; verifiedPaymentId?: string };

async function lookupSupport(
  tx: Prisma.TransactionClient, row: Workflow, request: SupportRequest,
): Promise<SupportEvidence | null> {
  const scope = { businessId: row.businessId, customerId: row.customerId };
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE "businessId" = ${row.businessId} AND "customerId" = ${row.customerId}
      AND "referenceNumber" = ${request.reference} AND "deletedAt" IS NULL FOR SHARE
  `;
  if (!locked) return null;
  const order = await tx.order.findFirstOrThrow({ where: { id: locked.id, ...scope, deletedAt: null } });
  if (!request.payment) return {
    id: order.id, key: 'order-status:' + order.status,
    body: `Order ${order.referenceNumber} is ${orderStatuses[order.status]}.`,
  };
  const payment = await tx.paystackSettlement.findFirst({
    where: {
      request: { ...scope, orderId: order.id, status: 'PAID' },
      payment: { ...scope, orderId: order.id, confidence: 'GATEWAY_CONFIRMED', voidedAt: null, direction: 'IN' },
    },
    orderBy: { id: 'asc' }, select: { paymentId: true },
  });
  if (!payment) return null;
  return {
    id: order.id, key: 'verified-payment:' + payment.paymentId, verifiedPaymentId: payment.paymentId,
    body: `We verified a payment for order ${order.referenceNumber}.`,
  };
}

const supportReview = (reason: string): BusinessEvent => ({
  type: 'REVIEW', key: 'review:' + reason, state: 'REVIEW_REQUIRED', operator: 'CARE', reason,
});

export async function advanceSupport(
  tx: Prisma.TransactionClient, row: Workflow, source: SupportSource, request: SupportRequest,
  policy: WorkflowSettings, now: Date,
): Promise<BusinessEvent> {
  const facts = await lookupSupport(tx, row, request);
  if (!facts) return supportReview('SUPPORT_EVIDENCE_UNAVAILABLE');
  const approvalNeeded = request.exception || policy.supportMode !== 'VERIFIED_STATUS';
  if (approvalNeeded) {
    const existing = await tx.workflowApproval.findUnique({ where: { workflowId: row.id } });
    if (!existing) {
      const spec = pinnedDefinition(row.definition, row.version);
      if (!spec) return supportReview('DEFINITION_UNAVAILABLE');
      const expiresAt = new Date(+now + spec.approvalWindowMs);
      await tx.workflowApproval.create({ data: { workflowId: row.id, businessId: row.businessId,
        action: 'SEND_VERIFIED_STATUS', resourceId: facts.id, evidenceKey: facts.key,
        definitionVersion: row.version, policyRevision: row.policyRevision, expiresAt } });
      return {
        type: 'APPROVAL_REQUESTED', key: 'approval:requested', state: 'WAITING_OWNER_APPROVAL', operator: 'CARE',
        reason: 'OWNER_STATUS_APPROVAL', deadlineAt: expiresAt, facts: { orderId: facts.id, evidenceKey: facts.key },
        links: { orderId: facts.id },
      };
    }
    if (existing.decision !== 'APPROVED' || existing.resourceId !== facts.id || existing.evidenceKey !== facts.key ||
        existing.definitionVersion !== row.version || existing.policyRevision !== policy.revision ||
        +existing.expiresAt <= +now || existing.executedAt) {
      return supportReview('APPROVAL_STALE');
    }
    // Current authorization is the same account owner, whose active,
    // unsuspended account and policy are checked again by the scheduler.
    if (existing.action !== 'SEND_VERIFIED_STATUS') return supportReview('UNSUPPORTED_ACTION');
  }
  if (row.reason !== 'SUPPORT_FACTS_VERIFIED' && row.reason !== 'OWNER_APPROVED') {
    return {
      type: 'SUPPORT_LOOKUP', key: 'support:lookup', state: 'READY', operator: request.payment ? 'PAYMENTS' : 'SALES',
      reason: 'SUPPORT_FACTS_VERIFIED', facts: { orderId: facts.id, evidenceKey: facts.key }, links: { orderId: facts.id },
    };
  }
  const customer = await tx.customer.findFirst({ where: { id: row.customerId, businessId: row.businessId,
    deletedAt: null, blacklisted: false, waNumberInvalid: false, lastInboundAt: { gt: new Date(+now - day) } },
  select: { waNumber: true } });
  if (!customer) return supportReview('CUSTOMER_CHANNEL_UNAVAILABLE');
  const sendId = await persistOutboundSend(tx, {
    businessId: row.businessId, customerId: row.customerId, to: customer.waNumber, body: facts.body,
    relatedOrderId: facts.id, inReplyToMessageId: source.id,
    workflowAuthorization: { id: row.id, evidenceKey: facts.key, payment: request.payment },
    ...(!approvalNeeded ? { suppressIfOwnerRepliedSince: source.createdAt.toISOString() } : {}),
  }, 'workflow-status-' + row.id);
  if (!sendId) return supportReview('OUTBOUND_IDENTITY_CONFLICT');
  if (approvalNeeded) {
    await tx.workflowApproval.update({ where: { workflowId: row.id }, data: { executedAt: now } });
  }
  return {
    type: 'OUTBOUND_AUTHORIZED', key: 'send:' + sendId, state: 'WAITING_PROVIDER', operator: 'CARE',
    reason: 'CUSTOMER_REPLY_PENDING', deadlineAt: new Date(+now + 120 * minute), links: { sendId },
    facts: { sendId, orderId: facts.id, ...(facts.verifiedPaymentId ? { paymentId: facts.verifiedPaymentId } : {}) },
  };
}

export async function verifyWorkflowSend(tx: Prisma.TransactionClient, send: {
  workflowAuthorization: { id: string; evidenceKey: string; payment: boolean };
  id: string; businessId: string; customerId: string | null; orderId: string | undefined; body: string;
}): Promise<boolean> {
  const { id, evidenceKey, payment } = send.workflowAuthorization;
  const [policy] = await tx.$queryRaw<WorkflowSettings[]>`
    SELECT * FROM workflow_settings WHERE "businessId" = ${send.businessId} FOR SHARE
  `;
  if (!policy?.enabled || !send.customerId || !send.orderId) return false;
  const row = await tx.workflow.findFirst({ where: { id, businessId: send.businessId, customerId: send.customerId,
    orderId: send.orderId, sendId: send.id, state: 'WAITING_PROVIDER', policyRevision: policy.revision,
    deadlineAt: { gt: new Date() }, business: { suspendedAt: null } } });
  if (!row) return false;
  const source = await tx.message.findFirst({ where: { id: row.sourceId, businessId: row.businessId,
    customerId: row.customerId, direction: 'INBOUND' }, select: { textReceipt: {
    select: { businessId: true, phoneNumberId: true, ownershipId: true, kind: true },
  }, business: { select: { waPhoneNumberId: true } } } });
  const receipt = source?.textReceipt;
  if (!source || !receipt || receipt.kind !== 'TEXT' || receipt.businessId !== row.businessId || receipt.ownershipId === null ||
      source.business.waPhoneNumberId !== receipt.phoneNumberId) return false;
  const [binding] = await tx.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM whatsapp_phone_ownership WHERE id = ${receipt.ownershipId} AND "businessId" = ${row.businessId}
      AND "phoneNumberId" = ${receipt.phoneNumberId} AND "endedAt" IS NULL FOR SHARE
  `;
  if (!binding) return false;
  const order = await tx.order.findFirst({ where: { id: send.orderId, businessId: send.businessId, customerId: send.customerId },
    select: { referenceNumber: true } });
  if (!order) return false;
  const facts = await lookupSupport(tx, row, { reference: order.referenceNumber, payment, exception: false });
  return facts?.key === evidenceKey && facts.body === send.body;
}
