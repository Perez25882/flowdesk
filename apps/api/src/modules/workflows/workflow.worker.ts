import type { Prisma, Workflow, WorkflowSettings } from '@prisma/client';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';
import { day, minute, pinnedDefinition, presets, type BusinessEvent } from './workflow.contract.js';
import { runDueWorkflow, transition } from './workflow.store.js';
import { advanceSupport, supportRequest } from './workflow.support.js';
import { observeCommerceCommands } from '../commerce/commerce.workflow.js';
import { releasePreparation } from '../commerce/commerce.fulfillment.js';
import { invoiceAmounts } from '../commerce/commerce.invoices.js';
import type { CommerceRecoveryProbe } from '../commerce/commerce.recovery.js';
import { recoverServiceVisits } from '../bookings/service.visits.js';
import { observeServiceWorkflow } from '../bookings/service.workflow.js';
import { recoverServiceNotices } from '../bookings/service.notices.js';
import { manualServiceSource } from '../bookings/service.workflow-store.js';

type Transaction = Prisma.TransactionClient;
type Facts = Prisma.InputJsonObject;

const next = (type: BusinessEvent['type'], key: string, state: BusinessEvent['state'],
  operator: BusinessEvent['operator'], reason: string, facts?: Facts): BusinessEvent =>
  ({ type, key, state, operator, reason, ...(facts ? { facts } : {}) });

const review = (row: Workflow, reason: string): BusinessEvent =>
  next('REVIEW', `review:${row.recoveryCount}:${reason}`, 'REVIEW_REQUIRED', row.operator, reason);

function json(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function usageFacts(assistant: Prisma.JsonObject): Facts {
  const usage = json(assistant.usage ?? null);
  return { cost: 'unknown', ...(typeof usage.model === 'string' && typeof usage.inputTokens === 'number' &&
    typeof usage.outputTokens === 'number' ? { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) };
}

async function observeSend(tx: Transaction, row: Workflow, eventKey: string, now: Date): Promise<BusinessEvent | null> {
  const send = await tx.whatsAppSend.findUnique({
    where: { businessId_eventKey: { businessId: row.businessId, eventKey } },
  });
  if (!send) return row.sendId ? review(row, 'OUTBOUND_RECORD_UNAVAILABLE') : null;
  const identity = json(send.payload);
  if (identity.customerId !== row.customerId || identity.businessId !== row.businessId ||
      (row.sendId && row.sendId !== send.id)) return review(row, 'OUTBOUND_IDENTITY_CONFLICT');

  if (send.state === 'FAILED' || send.state === 'REVIEW_REQUIRED') {
    return { ...review(row, 'OUTBOUND_REQUIRES_REVIEW'), facts: { sendId: send.id, providerState: send.state, attempts: send.attempts } };
  }
  const evidence = { sendId: send.id, attempts: send.attempts, providerMessageId: send.providerMessageId, cost: 'unknown' };
  if (!row.sendId) return {
    ...next('OUTBOUND_AUTHORIZED', 'send:' + send.id, 'WAITING_PROVIDER', row.operator, 'CUSTOMER_REPLY_PENDING', evidence),
    links: { sendId: send.id }, deadlineAt: new Date(+now + 120 * minute),
  };
  if ((send.state === 'DELIVERED' || send.state === 'READ') && send.providerMessageId && send.deliveredAt) {
    return next('OUTBOUND_CONFIRMED', 'delivered:' + send.id, 'COMPLETED', row.operator, 'CUSTOMER_NOTIFIED',
      { ...evidence, deliveredAt: send.deliveredAt.toISOString() });
  }
  return null;
}

async function observeOrder(tx: Transaction, row: Workflow, orderId: string, now: Date, probe?: CommerceRecoveryProbe): Promise<BusinessEvent | null> {
  const scope = { businessId: row.businessId, customerId: row.customerId };
  const sourceId = row.actionSourceId ?? row.sourceId;
  const order = await tx.order.findFirst({ where: { id: orderId, ...scope, deletedAt: null,
    OR: [{ inboundSourceMessageId: sourceId }, { commerceQuote: { sourceId } }] },
    include: { shipment: { select: { id: true, businessId: true, dispatchedAt: true, deliveredAt: true } },
      commerceQuote: { select: { id: true, deliveryMode: true } }, commerceInvoice: { include: { preparation: true } } } });
  if (!order) return review(row, 'ORDER_EVIDENCE_UNAVAILABLE');
  if (order.status === 'CANCELLED') {
    return next('CANCELLED', 'order:cancelled', 'CANCELLED', 'SALES', 'ORDER_CANCELLED', { orderId });
  }
  if (!row.orderId) return {
    ...next('ORDER_LINKED', 'order:' + orderId, 'WAITING_STAFF', 'SALES', 'ORDER_RECORDED', { orderId,
      ...(order.commerceInvoice ? { invoiceId: order.commerceInvoice.id, quoteId: order.commerceQuote?.id ?? null } : {}) }),
    links: { orderId }, deadlineAt: new Date(+now + 7 * day),
  };
  if (!order.totalAmount.gt(0)) return review(row, 'PAYABLE_TOTAL_UNAVAILABLE');

  const settlement = await tx.paystackSettlement.findFirst({
    where: {
      request: { ...scope, orderId, status: 'PAID' },
      payment: { ...scope, orderId, confidence: 'GATEWAY_CONFIRMED', direction: 'IN', voidedAt: null },
    },
    orderBy: [{ payment: { attestedAt: 'desc' } }, { id: 'asc' }],
    select: { id: true, requestId: true, paymentId: true },
  });
  const paid = settlement && (order.commerceInvoice
    ? (await invoiceAmounts(tx, order.commerceInvoice)).verified.gte(order.commerceInvoice.releaseThreshold)
    : order.amountPaid.gte(order.totalAmount));
  if (!paid) {
    if (row.operator === 'FULFILLMENT' || row.operator === 'CARE') return review(row, 'SETTLEMENT_NO_LONGER_VERIFIED');
    const request = await tx.paymentRequest.findFirst({ where: { ...scope, orderId, status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { id: 'asc' }, select: { id: true, expiresAt: true } });
    if (order.commerceInvoice && settlement) return next('PAYMENT_REQUEST', 'balance:' + settlement.id,
      'WAITING_PROVIDER', 'PAYMENTS', 'AWAITING_INVOICE_BALANCE', { orderId, paymentId: settlement.paymentId, invoiceId: order.commerceInvoice.id });
    return request
      ? next('PAYMENT_REQUEST', 'checkout:' + request.id, 'WAITING_PROVIDER', 'PAYMENTS', 'AWAITING_VERIFIED_PAYMENT',
          { orderId, requestId: request.id, expiresAt: request.expiresAt.toISOString() })
      : row.reason === 'AWAITING_VERIFIED_PAYMENT'
        ? review(row, 'PAYMENT_REQUEST_EXPIRED_OR_CHANGED') : null;
  }
  if (row.operator === 'SALES') {
    return next('PAYMENT_REQUEST', 'checkout:' + settlement.requestId, 'WAITING_PROVIDER', 'PAYMENTS', 'AWAITING_VERIFIED_PAYMENT',
      { orderId, requestId: settlement.requestId });
  }
  if (row.operator === 'PAYMENTS') {
    if (order.commerceInvoice) {
      await probe?.('before-preparation');
      if (!await releasePreparation(tx, row.businessId, orderId)) return review(row, 'PREPARATION_NOT_RELEASED');
      await probe?.('after-preparation-write');
    }
    return next('PAYMENT_SETTLED', 'settlement:' + settlement.id, 'WAITING_STAFF', 'FULFILLMENT', 'READY_FOR_FULFILLMENT',
      { orderId, ...settlement, ...(order.commerceInvoice ? { invoiceId: order.commerceInvoice.id } : {}) });
  }
  if (order.commerceQuote?.deliveryMode === 'PICKUP') {
    const collected = order.commerceInvoice?.preparation?.collectedAt;
    if (order.status !== 'FULFILLED' || !collected) return null;
    if (row.operator === 'FULFILLMENT') return next('PICKUP_COMPLETED', 'pickup:' + orderId, 'READY', 'CARE', 'PICKUP_CONFIRMED',
      { orderId, collectedAt: collected.toISOString() });
    return observeSend(tx, row, 'order-status-' + orderId + '-FULFILLED', now);
  }
  const shipment = order.shipment;
  if (!shipment || !shipment.dispatchedAt) {
    return order.status === 'FULFILLED' ? review(row, 'SHIPMENT_EVIDENCE_UNAVAILABLE') : null;
  }
  if (shipment.businessId !== row.businessId) return review(row, 'SHIPMENT_IDENTITY_CONFLICT');
  if (row.reason === 'READY_FOR_FULFILLMENT') {
    return next('DELIVERY_DISPATCHED', 'dispatch:' + shipment.id, 'WAITING_STAFF', 'FULFILLMENT', 'SHIPMENT_DISPATCHED',
      { orderId, shipmentId: shipment.id, dispatchedAt: shipment.dispatchedAt.toISOString() });
  }
  if (order.status !== 'FULFILLED' || !shipment.deliveredAt) return null;
  if (row.operator === 'FULFILLMENT') {
    return next('DELIVERY_COMPLETED', 'delivery:' + shipment.id, 'READY', 'CARE', 'SHIPMENT_DELIVERED',
      { orderId, shipmentId: shipment.id, deliveredAt: shipment.deliveredAt.toISOString() });
  }
  const task = await tx.fulfillmentTask.findFirst({ where: {
    businessId: row.businessId, orderId, kind: 'NOTIFY', subject: 'FULFILLED', state: { in: ['FAILED', 'SUPPRESSED'] },
  }, select: { id: true } });
  if (task) return { ...review(row, 'FULFILLMENT_NOTICE_BLOCKED'), facts: { taskId: task.id } };
  return observeSend(tx, row, 'order-status-' + orderId + '-FULFILLED', now);
}

async function reconcile(tx: Transaction, row: Workflow, policy: WorkflowSettings, now: Date, probe?: CommerceRecoveryProbe): Promise<BusinessEvent | null> {
  const customer = { businessId: row.businessId, customerId: row.customerId };
  const source = await tx.message.findFirst({
    where: { id: row.actionSourceId ?? row.sourceId, ...customer, direction: 'INBOUND', type: 'TEXT',
      customer: { businessId: row.businessId, deletedAt: null, blacklisted: false } },
    select: { id: true, body: true, createdAt: true, intent: true, processed: true, processingError: true, requiresReview: true,
      aiPolicy: true, aiReplyGroundedOn: true },
  });
  if (!source) return review(row, 'SOURCE_UNAVAILABLE');
  if (!source.processed || source.processingError === 'CLASSIFICATION_EFFECT_WAITING' ||
      source.processingError === 'ORDER_EFFECT_WAITING') return null;

  const commerce = row.version === 3 ? await observeCommerceCommands(tx, row, source, now) : undefined;
  if (commerce !== undefined) return commerce;

  const support = supportRequest(source.body, source.intent === 'STATUS_CHECK');
  if (support) {
    if (row.sendId) return observeSend(tx, row, 'workflow-status-' + row.id, now);
    return advanceSupport(tx, row, source, support, policy, now);
  }
  const assistant = json(source.aiPolicy);
  if (assistant.state === 'HANDED_OFF' && assistant.effect === 'checkout') {
    const requestId = source.aiReplyGroundedOn.find((id) => id.startsWith('payment_request:'))?.slice('payment_request:'.length);
    const orderId = source.aiReplyGroundedOn.find((id) => id.startsWith('order:'))?.slice('order:'.length);
    if (!requestId || !orderId) return review(row, 'CHECKOUT_EVIDENCE_UNAVAILABLE');
    const request = await tx.paymentRequest.findFirst({ where: { id: requestId, orderId, ...customer,
      order: { ...customer, deletedAt: null, status: { not: 'CANCELLED' } } }, select: { id: true } });
    if (!request) return review(row, 'CHECKOUT_EVIDENCE_UNAVAILABLE');
    const event = await observeSend(tx, { ...row, operator: 'PAYMENTS' }, 'assistant-checkout-' + source.id, now);
    return event ? { ...event, facts: { ...event.facts, orderId, requestId } } : null;
  }
  const flows = presets[policy.profile as keyof typeof presets] as readonly string[] | undefined;
  const order = await tx.order.findFirst({ where: { ...customer, deletedAt: null,
    OR: [{ inboundSourceMessageId: source.id }, { commerceQuote: { sourceId: source.id } }] }, select: { id: true } });
  if (order) return flows?.includes('commerce') ? observeOrder(tx, row, order.id, now, probe) : review(row, 'COMMERCE_PRESET_UNAVAILABLE');
  if (row.orderId) return review(row, 'ORDER_EVIDENCE_UNAVAILABLE');

  const appointment = await tx.appointment.findFirst({ where: { assistantMessageId: source.id, ...customer,
    service: { businessId: row.businessId } }, select: { id: true, status: true, startsAt: true, serviceId: true } });
  if (appointment) {
    if (!flows?.includes('appointment')) return review(row, 'APPOINTMENT_PRESET_UNAVAILABLE');
    if (appointment.status === 'CANCELLED') {
      return next('CANCELLED', 'appointment:cancelled', 'CANCELLED', 'BOOKINGS', 'APPOINTMENT_CANCELLED', { appointmentId: appointment.id });
    }
    if (appointment.status === 'NO_SHOW') return review(row, 'APPOINTMENT_NO_SHOW');
    if (!row.appointmentId) return {
      ...next('APPOINTMENT_BOOKED', 'appointment:' + appointment.id, 'READY', 'BOOKINGS', 'APPOINTMENT_BOOKED',
        { appointmentId: appointment.id, serviceId: appointment.serviceId, startsAt: appointment.startsAt.toISOString(), ...usageFacts(assistant) }),
      links: { appointmentId: appointment.id },
    };
    return observeSend(tx, { ...row, operator: 'CARE' }, 'assistant-reply-' + source.id, now);
  }
  if (row.appointmentId) return review(row, 'APPOINTMENT_EVIDENCE_UNAVAILABLE');
  if (source.requiresReview || source.processingError || assistant.state === 'REVIEW' || assistant.state === 'WAITING_HANDOFF') {
    return review(row, 'INBOUND_REQUIRES_TEAM_REVIEW');
  }
  if (assistant.state === 'WAITING_CUSTOMER') return next('CUSTOMER_INPUT', 'waiting:customer',
    'WAITING_CUSTOMER', 'SALES', 'CUSTOMER_DETAILS_NEEDED');
  if (assistant.state === 'HANDED_OFF' && source.aiReplyGroundedOn.some((id) => id.startsWith('product:')) &&
      flows?.includes('commerce') && row.reason === 'INBOUND_PROCESSING') {
    return next('SALES_QUOTE', 'quote:' + source.id, 'READY', 'SALES', 'VERIFIED_QUOTE',
      { sourceId: source.id, ...usageFacts(assistant) });
  }
  if (row.reason === 'VERIFIED_QUOTE' || row.reason === 'QUOTE_AWAITING_PURCHASE') {
    const confirmed = await observeSend(tx, row, 'assistant-reply-' + source.id, now);
    if (confirmed?.state === 'REVIEW_REQUIRED') return confirmed;
    if (row.reason === 'QUOTE_AWAITING_PURCHASE') return null;
    return next('CUSTOMER_INPUT', 'quote:customer', 'WAITING_CUSTOMER', 'SALES', 'QUOTE_AWAITING_PURCHASE', confirmed?.facts);
  }
  if (assistant.state === 'HANDED_OFF') return observeSend(tx, row, 'assistant-reply-' + source.id, now);
  return review(row, 'SUPPORTED_OUTCOME_UNAVAILABLE');
}

async function advance(tx: Transaction, row: Workflow, now: Date, probe?: CommerceRecoveryProbe): Promise<void> {
  const policy = (await tx.$queryRaw<WorkflowSettings[]>`
    SELECT * FROM workflow_settings WHERE "businessId" = ${row.businessId} FOR SHARE
  `)[0];
  const active = await tx.business.findFirst({ where: { id: row.businessId, active: true, suspendedAt: null,
    deletedAt: null, deactivatedAt: null }, select: { id: true } });
  let event: BusinessEvent | null = null;
  if (!pinnedDefinition(row.definition, row.version)) event = review(row, 'DEFINITION_UNAVAILABLE');
  else if (!active || (!(row.version === 4 && row.sourceId.startsWith(manualServiceSource)) &&
      (!policy?.enabled || policy.revision !== row.policyRevision))) event = review(row, 'BUSINESS_POLICY_CHANGED');
  else if (+row.deadlineAt <= +now) event = review(row, row.state === 'WAITING_OWNER_APPROVAL' ? 'APPROVAL_EXPIRED' : 'DEPENDENCY_DEADLINE_EXPIRED');
  else if (row.state === 'CREATED') event = next('PROCESSING', 'inbound:processing', 'RUNNING', 'CARE', 'INBOUND_PROCESSING');
  else if (row.state !== 'WAITING_OWNER_APPROVAL') event = row.version === 4
    ? await observeServiceWorkflow(tx, row, now, probe) : await reconcile(tx, row, policy!, now, probe);

  const stop = event && ['REVIEW_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(event.state);
  const waitingApproval = (event?.state ?? row.state) === 'WAITING_OWNER_APPROVAL';
  const dueAt = stop ? null : new Date(Math.min(+(event?.deadlineAt ?? row.deadlineAt), +now + (waitingApproval ? 30_000 : 2_000)));
  if (event) await transition(tx, row, event, dueAt);
  else await tx.workflow.update({ where: { id: row.id }, data: { dueAt } });
}

export async function recoverWorkflows(now = new Date(), probe?: CommerceRecoveryProbe): Promise<void> {
  await recoverServiceVisits(now, probe);
  await recoverServiceNotices(now, probe);
  await prisma.$executeRaw`
    UPDATE commerce_quotes SET state = 'EXPIRED'
    WHERE id IN (SELECT id FROM commerce_quotes WHERE state IN ('DRAFT', 'OFFERED') AND "expiresAt" <= ${now}
      ORDER BY "expiresAt", id LIMIT 12 FOR UPDATE SKIP LOCKED)
  `;
  for (let count = 0; count < 12; count++) {
    if (!await runDueWorkflow(now, (tx, row, tick) => advance(tx, row, tick, probe))) return;
    await probe?.('after-workflow-commit');
  }
}

export function startWorkflowRecovery(): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout;
  let active: Promise<void>;
  function tick(): void {
    active = recoverWorkflows().catch((error: Error) => logger.warn({ name: error.name }, 'Workflow scheduler pass failed'))
      .finally(() => { if (!stopped) timer = setTimeout(tick, 1_000); });
  }
  tick();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
