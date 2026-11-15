import type { CommercePreparation, CommercePreparationState, Prisma } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { requirePaymentActor } from '../payments/payment-relationships.js';
import { requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { invoiceAmounts } from './commerce.invoices.js';

type Tx = Prisma.TransactionClient;

async function preparationForOrder(tx: Tx, businessId: string, orderId: string) {
  return tx.commerceInvoice.findFirst({ where: { orderId, businessId },
    include: { preparation: true, order: { select: { status: true, commerceQuote: { include: { lines: true } } } } } });
}

export async function releasePreparation(tx: Tx, businessId: string, orderId: string): Promise<string | null> {
  const [order] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${orderId} AND "businessId" = ${businessId} AND "deletedAt" IS NULL FOR UPDATE
  `;
  if (!order) return null;
  const invoice = await preparationForOrder(tx, businessId, orderId);
  if (!invoice || invoice.order.status === 'CANCELLED' || !invoice.order.commerceQuote) return null;
  if (!(await invoiceAmounts(tx, invoice)).verified.gte(invoice.releaseThreshold)) return null;
  await tx.commercePreparation.createMany({
    data: { invoiceId: invoice.id, businessId,
      madeToOrder: invoice.order.commerceQuote.lines.some((line) => line.productMode === 'MADE_TO_ORDER') },
    skipDuplicates: true,
  });
  return invoice.id;
}

export async function requireCommercePreparation(tx: Tx, businessId: string, orderId: string): Promise<void> {
  const invoice = await preparationForOrder(tx, businessId, orderId);
  if (!invoice) return;
  if (!invoice.preparation || invoice.preparation.state === 'CANCELLED' ||
      !(await invoiceAmounts(tx, invoice)).verified.gte(invoice.releaseThreshold)) {
    throw new ConflictError('Verified payment is required before preparation');
  }
}

export async function prepareForDelivery(
  tx: Tx, actor: OrderActor, orderId: string, next: 'DISPATCHED' | 'FULFILLED', current: string,
): Promise<void> {
  const invoice = await preparationForOrder(tx, actor.businessId, orderId);
  if (!invoice) return;
  if (!invoice.order.commerceQuote || !invoice.preparation || invoice.preparation.state !== 'READY' ||
      !(await invoiceAmounts(tx, invoice)).verified.gte(invoice.releaseThreshold)) {
    throw new ConflictError('Verified payment and completed preparation are required');
  }
  if (invoice.order.commerceQuote.deliveryMode === 'PICKUP') {
    if (next !== 'FULFILLED' || current !== 'PROCESSING' || actor.role === 'DELIVERY') {
      throw new ForbiddenError('This order requires authorized pickup confirmation');
    }
    await tx.commercePreparation.update({ where: { invoiceId: invoice.id }, data: { state: 'COLLECTED', collectedAt: new Date() } });
  } else if (next === 'FULFILLED' && current !== 'DISPATCHED') {
    throw new ConflictError('Dispatch must be confirmed before delivery');
  }
}

export async function updatePreparation(
  tx: Tx, actor: OrderActor, orderId: string, state: Extract<CommercePreparationState, 'PREPARING' | 'READY'>,
  assignedStaffId: string | null,
): Promise<CommercePreparation> {
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'orders.create');
  await requireStaffMembership(tx, actor);
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${orderId} AND "businessId" = ${actor.businessId} AND "deletedAt" IS NULL FOR UPDATE
  `;
  if (!locked) throw new NotFoundError('Order not found');
  const invoice = await preparationForOrder(tx, actor.businessId, orderId);
  if (!invoice?.preparation || invoice.order.status !== 'PROCESSING' ||
      !['PREPARING', 'READY'].includes(invoice.preparation.state) ||
      !(await invoiceAmounts(tx, invoice)).verified.gte(invoice.releaseThreshold)) {
    throw new ConflictError('This order cannot be prepared now');
  }
  if (actor.role === 'OPERATIONS' && (assignedStaffId !== actor.staffId ||
      (invoice.preparation.assignedStaffId && invoice.preparation.assignedStaffId !== actor.staffId))) {
    throw new ForbiddenError('This preparation belongs to other staff');
  }
  if (assignedStaffId) {
    const [staff] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM staff WHERE id = ${assignedStaffId} AND "businessId" = ${actor.businessId}
        AND active AND role IN ('MANAGER','OPERATIONS') FOR SHARE
    `;
    if (!staff) throw new NotFoundError('Preparation staff not found');
  }
  if (invoice.preparation.state === 'READY' && state !== 'READY') throw new ConflictError('Prepared orders require review to reopen');
  return tx.commercePreparation.update({ where: { invoiceId: invoice.id },
    data: { state, assignedStaffId, readyAt: state === 'READY' ? invoice.preparation.readyAt ?? new Date() : null } });
}

export async function cancelCommerceOrder(tx: Tx, businessId: string, customerId: string, orderId: string, current: string): Promise<void> {
  const invoice = await preparationForOrder(tx, businessId, orderId);
  if (!invoice) return;
  if (current === 'DISPATCHED') throw new ConflictError('Return of dispatched goods requires verified staff review');
  await tx.commercePreparation.updateMany({ where: { businessId, invoiceId: invoice.id }, data: { state: 'CANCELLED' } });
  await tx.paymentRequest.updateMany({ where: { businessId, customerId, orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
}
