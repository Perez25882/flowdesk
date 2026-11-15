import type { CommerceCaseKind, Prisma, Workflow } from '@prisma/client';
import { persistOutboundSend } from '../../queues/outbound.queue.js';
import { isAppError } from '../../utils/errors.js';
import { followupConsent, quoteCommand, quoteInput } from './commerce.contract.js';
import { acceptCommerceQuote, createCommerceQuote, decideCommerceQuote, loadCommerceSource } from './commerce.quotes.js';
import type { BusinessEvent } from '../workflows/workflow.contract.js';
import { minute } from '../workflows/workflow.contract.js';

type Tx = Prisma.TransactionClient;
type Source = { id: string; body: string | null; intent: string; createdAt: Date };

export function commerceCaseKind(body: string | null, complaint: boolean): CommerceCaseKind | null {
  if (!body) return null;
  if (/\b(?:cancel|cancellation)\b/i.test(body)) return 'CANCELLATION';
  if (/\b(?:return|refund)\b/i.test(body)) return 'RETURN';
  if (/\b(?:exchange|replace)\b/i.test(body)) return 'EXCHANGE';
  if (complaint || /\b(?:missing item|wrong item|wrong product|damaged item|damaged product)\b/i.test(body)) return 'COMPLAINT';
  return null;
}

async function send(tx: Tx, row: Workflow, source: Source, eventKey: string, body: string, relatedOrderId?: string) {
  const customer = await tx.customer.findFirst({ where: { businessId: row.businessId, id: row.customerId,
    deletedAt: null, blacklisted: false, waNumberInvalid: false,
    lastInboundAt: { gt: new Date(Date.now() - 24 * 60 * minute) } }, select: { waNumber: true } });
  if (!customer) return null;
  const prior = await tx.whatsAppSend.findUnique({ where: { businessId_eventKey: { businessId: row.businessId, eventKey } }, select: { id: true } });
  return prior?.id ?? persistOutboundSend(tx, {
    businessId: row.businessId, customerId: row.customerId, to: customer.waNumber, body, inReplyToMessageId: source.id,
    ...(relatedOrderId ? { relatedOrderId } : {}), suppressIfOwnerRepliedSince: source.createdAt.toISOString(),
  }, eventKey);
}

const review = (reason: string): BusinessEvent => ({
  type: 'REVIEW', key: 'commerce:review:' + reason, state: 'REVIEW_REQUIRED', operator: 'CARE', reason,
});

async function observeCase(tx: Tx, row: Workflow, source: Source, kind: CommerceCaseKind): Promise<BusinessEvent | null> {
  const scope = { businessId: row.businessId, customerId: row.customerId };
  await loadCommerceSource(tx, scope, source.id);
  const ref = source.body?.match(/\bFD-[A-Z0-9]{3,}\b/i)?.[0]?.toUpperCase();
  const order = ref ? await tx.order.findFirst({ where: { ...scope, referenceNumber: ref, deletedAt: null }, select: { id: true } }) : null;
  const existing = await tx.commerceCase.upsert({
    where: { businessId_sourceId: { businessId: row.businessId, sourceId: source.id } }, update: {},
    create: { ...scope, sourceId: source.id, orderId: order?.id ?? null, kind,
      history: { create: { revision: 0, state: 'OPEN' } } },
  });
  if (existing.state === 'OPEN') await send(tx, row, source, 'commerce-case-ack-' + existing.id,
    'Your request is with the shop team. Your case reference is ' + existing.id +
    '. When the issue is resolved, reply RESOLVED ' + existing.id + '.');
  if (existing.state === 'RESOLVED') return {
    type: 'COMMERCE_RESOLVED', key: 'case:resolved:' + existing.id, state: 'COMPLETED', operator: 'CARE',
    reason: 'CASE_RESOLVED', facts: { caseId: existing.id, resolution: existing.resolution },
  };
  return {
    type: 'COMMERCE_CASE', key: `case:${existing.id}:${existing.revision}`,
    state: existing.state === 'WAITING' ? 'WAITING_CUSTOMER' : 'WAITING_STAFF', operator: 'CARE',
    reason: 'CUSTOMER_CASE_OPEN', facts: { caseId: existing.id, kind: existing.kind, caseState: existing.state },
  };
}

export async function observeCommerceCommands(
  tx: Tx, row: Workflow, source: Source, now: Date,
): Promise<BusinessEvent | null | undefined> {
  const command = quoteCommand(source.body);
  const consent = followupConsent(source.body);
  const kind = commerceCaseKind(source.body, source.intent === 'COMPLAINT');
  if (!command && !kind && consent === undefined) return undefined;
  if (!await tx.commercePolicy.findUnique({ where: { businessId: row.businessId, enabled: true }, select: { businessId: true } })) return undefined;
  const scope = { businessId: row.businessId, customerId: row.customerId };
  await tx.$executeRawUnsafe('SAVEPOINT observe_commerce_command');
  try {
    if (consent !== undefined) {
      await loadCommerceSource(tx, scope, source.id);
      await tx.customer.updateMany({ where: { id: row.customerId, businessId: row.businessId,
        OR: [{ commerceConsentAt: null }, { commerceConsentAt: { lt: source.createdAt } },
          ...(!consent ? [{ commerceConsentAt: source.createdAt, commerceFollowup: true }] : [])] },
      data: { commerceConsentAt: source.createdAt, commerceConsentId: source.id, commerceFollowup: consent } });
      return { type: 'COMMERCE_RESOLVED', key: 'consent:' + source.id, state: 'COMPLETED', operator: 'CARE',
        reason: 'ORDER_FOLLOWUP_PREFERENCE_RECORDED', facts: { sourceId: source.id } };
    }
    if (!command) return await observeCase(tx, row, source, kind!);
    await loadCommerceSource(tx, scope, source.id);
    if (command.kind === 'decline') {
      const quote = await tx.commerceQuote.findFirst({ where: { ...scope, id: command.id }, select: { id: true } });
      if (!quote) return review('QUOTE_UNAVAILABLE');
      await decideCommerceQuote(tx, row.businessId, command.id, false, now);
      return { type: 'CANCELLED', key: 'quote:declined:' + command.id, state: 'CANCELLED', operator: 'SALES',
        reason: 'QUOTE_DECLINED', facts: { quoteId: command.id } };
    }
    if (command.kind === 'accept') {
      const quote = await acceptCommerceQuote(tx, scope, command.id, source.id, now);
      if (!quote.orderId) return review('ORDER_UNAVAILABLE');
      const invoice = await tx.commerceInvoice.findUniqueOrThrow({ where: { orderId: quote.orderId } });
      const labels = quote.lines.map((line) => `${line.quantity} × ${line.itemName}: GHS ${line.unitPrice.toFixed(2)} each`);
      const body = [`Invoice ${invoice.reference}`, ...labels, `Total: GHS ${invoice.total.toFixed(2)}`,
        ...(invoice.deposit.gt(0) ? [`Deposit: GHS ${invoice.deposit.toFixed(2)}`] : []),
        `Due: ${invoice.dueAt.toISOString().slice(0, 10)}`].join('\n');
      const sendId = await send(tx, row, source, 'commerce-invoice-' + invoice.id, body, quote.orderId);
      if (quote.sourceId) {
        if (!sendId) return review('INVOICE_NOTICE_UNAVAILABLE');
        const delivery = await tx.whatsAppSend.findFirst({ where: { id: sendId, businessId: row.businessId }, select: {
          state: true, providerMessageId: true, deliveredAt: true,
        } });
        if (delivery?.state === 'FAILED' || delivery?.state === 'REVIEW_REQUIRED') return review('INVOICE_NOTICE_NEEDS_REVIEW');
        if (delivery?.deliveredAt && delivery.providerMessageId) return {
          type: 'COMMERCE_RESOLVED', key: 'invoice:delivered:' + invoice.id, state: 'COMPLETED', operator: 'PAYMENTS',
          reason: 'INVOICE_DELIVERED', facts: { invoiceId: invoice.id, orderId: quote.orderId, sendId },
        };
        return {
          type: 'COMMERCE_INVOICE', key: 'invoice:issued:' + invoice.id, state: 'WAITING_PROVIDER', operator: 'PAYMENTS',
          reason: 'INVOICE_NOTICE_PENDING', facts: { invoiceId: invoice.id, orderId: quote.orderId, sendId },
        };
      }
      return undefined;
    }
    const selected = await tx.product.findMany({ where: { businessId: row.businessId, active: true, deletedAt: null,
      OR: command.items.map(({ sku }) => ({ sku: { equals: sku, mode: 'insensitive' } })) },
    select: { id: true, sku: true } });
    const items = command.items.map(({ sku, quantity }) => {
      const candidates = selected.filter((product) => product.sku?.toUpperCase() === sku);
      return { productId: candidates.length === 1 ? candidates[0]!.id : '', quantity };
    });
    const parsed = quoteInput.safeParse({ customerId: row.customerId,
      requestKey: 'inbound:' + source.id, sourceId: source.id, deliveryMode: command.deliveryMode,
      address: command.address, specification: command.specification, items });
    if (!parsed.success) return review('QUOTE_INFORMATION_REQUIRED');
    const quote = await createCommerceQuote(tx, row.businessId, parsed.data, now);
    if (quote.state === 'ACCEPTED') return undefined;
    if (quote.state === 'DECLINED' || quote.state === 'EXPIRED' || +quote.expiresAt <= +now) return {
      type: 'CANCELLED', key: 'quote:ended:' + quote.id, state: 'CANCELLED', operator: 'SALES',
      reason: 'QUOTE_NO_LONGER_AVAILABLE', facts: { quoteId: quote.id },
    };
    if (quote.state === 'OFFERED') {
      const lines = quote.lines.map((line) => `${line.quantity} × ${line.itemName} at GHS ${line.unitPrice.toFixed(2)}`);
      const body = [...lines, ...(quote.specification ? [`Specification: ${quote.specification}`] : []),
        `Quote total: GHS ${quote.total.toFixed(2)}.`, `Reply ACCEPT ${quote.id} to confirm.`,
        `Quote expires at ${quote.expiresAt.toISOString()}.`].join('\n');
      if (!await send(tx, row, source, 'commerce-quote-' + quote.id, body)) return review('QUOTE_NOTICE_UNAVAILABLE');
    }
    return {
      type: 'COMMERCE_QUOTE', key: `quote:${quote.id}:${quote.state}`, state: quote.state === 'DRAFT' ? 'WAITING_STAFF' : 'WAITING_CUSTOMER',
      operator: 'SALES', reason: quote.state === 'DRAFT' ? 'CUSTOM_QUOTE_REVIEW' : 'QUOTE_AWAITS_ACCEPTANCE',
      facts: { quoteId: quote.id, expiresAt: quote.expiresAt.toISOString() },
    };
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT observe_commerce_command');
    if (!isAppError(error) || error.statusCode >= 500) throw error;
    return review('COMMERCE_EVIDENCE_CHANGED');
  } finally {
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT observe_commerce_command');
  }
}
