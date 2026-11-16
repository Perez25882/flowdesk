import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type CommerceInvoice } from '@prisma/client';
import { lockPaymentRelationship } from '../payments/payment-relationships.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { persistOutboundSend } from '../../queues/outbound.queue.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import type { InvoiceDraftInput } from './commerce.contract.js';

type Tx = Prisma.TransactionClient;

export function draftId(businessId: string, requestKey: string): string {
  return 'draft-' + createHash('sha256').update(businessId + ':' + requestKey).digest('hex');
}

export async function createInvoiceDraft(tx: Tx, businessId: string, input: InvoiceDraftInput): Promise<CommerceInvoice> {
  const dueAt = new Date(input.dueAt);
  const lines = input.lines.map(({ description, quantity, unitMinor }) => ({
    name: description, sku: null, quantity, listPrice: (unitMinor / 100).toFixed(2), unitPrice: (unitMinor / 100).toFixed(2),
    subtotal: (quantity * unitMinor / 100).toFixed(2),
  }));
  const total = new Prisma.Decimal(input.lines.reduce((sum, line) => sum + line.quantity * line.unitMinor, 0)).div(100);
  if (total.gt(1_000_000)) throw new ValidationError('Invoice total is too large');
  await lockPaymentRelationship(tx, { businessId, customerId: input.customerId });
  const id = input.requestKey ? draftId(businessId, input.requestKey) : randomUUID();
  if (input.requestKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const prior = await tx.commerceInvoice.findUnique({ where: { id_businessId: { id, businessId } } });
    if (prior) {
      const priorLines = (prior.receiptLines as typeof lines).map((line) => [line.name, line.quantity, line.unitPrice]);
      const nextLines = lines.map((line) => [line.name, line.quantity, line.unitPrice]);
      if (prior.customerId !== input.customerId || +prior.dueAt !== +dueAt || prior.terms !== (input.terms ?? null) ||
          JSON.stringify(priorLines) !== JSON.stringify(nextLines)) throw new ConflictError('This invoice request already belongs to a different draft');
      return prior;
    }
  }
  if (dueAt <= new Date()) throw new ValidationError('Invoice due date must be in the future');
  const invoice = await tx.commerceInvoice.create({ data: {
    id, businessId, customerId: input.customerId, reference: 'INV-' + id.toUpperCase(), status: 'DRAFT',
    receiptLines: lines, total, releaseThreshold: total, dueAt, terms: input.terms ?? null,
  } });
  await logActivity({ businessId, staffId: null, action: 'invoice.drafted', resourceId: id, resourceType: 'invoice' }, tx);
  return invoice;
}

export async function standaloneInvoiceForMutation(tx: Tx, businessId: string, id: string): Promise<CommerceInvoice> {
  const invoice = await tx.commerceInvoice.findFirst({ where: { id, businessId, orderId: null, serviceVisit: null } });
  if (!invoice) throw new NotFoundError('Standalone invoice not found');
  await lockPaymentRelationship(tx, invoice);
  return tx.commerceInvoice.findUniqueOrThrow({ where: { id_businessId: { id, businessId } } });
}

export async function decideStandaloneInvoice(
  tx: Tx, businessId: string, id: string, action: 'ISSUE' | 'CANCEL' | 'SEND',
): Promise<{ invoice: CommerceInvoice; sendId?: string }> {
  const invoice = await standaloneInvoiceForMutation(tx, businessId, id);
  if (action === 'SEND') {
    if (invoice.status !== 'ISSUED') throw new ConflictError('Only an issued invoice can be sent');
    const customer = await tx.customer.findFirst({ where: { id: invoice.customerId, businessId, blacklisted: false,
      waNumberInvalid: false, lastInboundAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { waNumber: true } });
    if (!customer) throw new ConflictError('An open WhatsApp conversation with this customer is required');
    const lines = invoice.receiptLines as Array<{ name: string; quantity: number; unitPrice: string }>;
    const body = [`Invoice ${invoice.reference}`, ...lines.map((line) => `${line.quantity} × ${line.name} at GHS ${line.unitPrice}`),
      `Total GHS ${invoice.total.toFixed(2)}`, `Due ${invoice.dueAt.toISOString().slice(0, 10)}`, ...(invoice.terms ? [invoice.terms] : [])].join('\n');
    const eventKey = 'standalone-invoice-' + invoice.id;
    const sendId = await persistOutboundSend(tx, { businessId, customerId: invoice.customerId, to: customer.waNumber, body }, eventKey);
    return { invoice, sendId: sendId ?? (await tx.whatsAppSend.findUniqueOrThrow({
      where: { businessId_eventKey: { businessId, eventKey } }, select: { id: true },
    })).id };
  }
  const status = action === 'ISSUE' ? 'ISSUED' : 'CANCELLED';
  if (invoice.status === status) return { invoice };
  if (action === 'ISSUE' && (invoice.status !== 'DRAFT' || invoice.dueAt <= new Date())) {
    throw new ConflictError('Invoice can no longer be issued');
  }
  const updated = await tx.commerceInvoice.update({ where: { id_businessId: { id, businessId } }, data: {
    status, ...(action === 'ISSUE' ? { issuedAt: new Date() } : {}),
  } });
  if (status === 'CANCELLED') await tx.paymentRequest.updateMany({ where: { invoiceId: id, businessId, status: 'PENDING' }, data: { status } });
  await logActivity({ businessId, staffId: null, action: `invoice.${status.toLowerCase()}`, resourceId: id, resourceType: 'invoice' }, tx);
  return { invoice: updated };
}
