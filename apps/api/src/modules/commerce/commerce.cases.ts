import type { CommerceCase, Prisma } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { requirePaymentActor } from '../payments/payment-relationships.js';
import { claimStockMovement } from '../orders/orders.repository.js';
import { restoreStockForOrderItems } from '../products/products.repository.js';
import { lockCommerceProducts } from './commerce.stock.js';
import type { caseInput } from './commerce.contract.js';
import type { z } from 'zod';
import { loadCommerceSource } from './commerce.quotes.js';

export async function updateCommerceCase(
  tx: Prisma.TransactionClient, actor: OrderActor, id: string, input: z.infer<typeof caseInput>,
): Promise<CommerceCase> {
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'messages.send');
  await requireStaffMembership(tx, actor);
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM commerce_cases WHERE id = ${id} AND "businessId" = ${actor.businessId} FOR UPDATE
  `;
  if (!locked) throw new NotFoundError('Case not found');
  const current = await tx.commerceCase.findUniqueOrThrow({ where: { id }, include: { order: { select: { status: true } } } });
  if (actor.role === 'OPERATIONS' && (input.staffId !== actor.staffId ||
      (current.assignedStaffId && current.assignedStaffId !== actor.staffId))) throw new ForbiddenError('Case assigned to other staff');
  if (current.revision !== input.revision || current.state === 'RESOLVED') throw new ConflictError('Case status changed');
  if (input.staffId) await requirePaymentActor(tx, actor.businessId, input.staffId, 'messages.send');
  if (input.state === 'ASSIGNED' && !input.staffId) throw new ValidationError('Choose an assigned staff member');
  if (input.state === 'RESOLVED') {
    if (await tx.commerceReturn.findFirst({ where: { caseId: id, businessId: actor.businessId, rejectedAt: null,
      OR: [{ resolvedAt: null }, { resolutionPayment: { voidedAt: { not: null } } }] }, select: { id: true } })) {
      throw new ConflictError('Return disposition requires current evidence');
    }
    if (input.resolution === 'CANCELLATION_CONFIRMED' && current.kind === 'CANCELLATION' && current.order?.status === 'CANCELLED') {
      // The verified order transition is the resolution evidence.
    } else if (input.resolution === 'CUSTOMER_CONFIRMED_RESOLUTION' && input.evidenceMessageId) {
      const source = await loadCommerceSource(tx, current, input.evidenceMessageId);
      if (+source.createdAt < +current.createdAt - 1000 || source.body?.trim().toUpperCase() !== ('RESOLVED ' + id).toUpperCase()) {
        throw new ConflictError('The message does not confirm this case');
      }
    } else throw new ConflictError('This case requires verified resolution evidence');
  } else if (input.resolution && (input.state !== 'ESCALATED' || input.resolution !== 'REFERRED_TO_OWNER')) {
    throw new ValidationError('Outcome requires confirmed resolution');
  }
  const resolution = input.resolution ?? null;
  const revision = current.revision + 1;
  return tx.commerceCase.update({ where: { id }, data: {
    state: input.state, assignedStaffId: input.staffId, resolution, revision,
    history: { create: { revision, state: input.state, staffId: actor.staffId, resolution,
      evidenceMessageId: input.evidenceMessageId ?? null } },
  } });
}

export async function receiveCommerceReturn(tx: Prisma.TransactionClient, actor: OrderActor, id: string, expectedRevision: number): Promise<CommerceCase> {
  if (actor.staffId !== null || actor.role !== undefined) throw new ForbiddenError('Only the owner can receive a stock return');
  const { businessId } = actor;
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM commerce_cases WHERE id = ${id} AND "businessId" = ${businessId} FOR UPDATE
  `;
  if (!locked) throw new NotFoundError('Return case not found');
  const item = await tx.commerceCase.findUniqueOrThrow({ where: { id } });
  if (item.kind !== 'RETURN' || !item.orderId) throw new ConflictError('This case has no eligible return order');
  const restocked = await tx.commerceCaseEvent.findFirst({ where: { caseId: id, businessId, resolution: 'RETURN_RECEIVED_TO_STOCK' }, select: { revision: true } });
  if (restocked) return item;
  if (item.revision !== expectedRevision || item.state === 'RESOLVED') throw new ConflictError('Return case status changed');
  const [owned] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${item.orderId} AND "businessId" = ${businessId}
      AND "customerId" = ${item.customerId} AND "deletedAt" IS NULL FOR UPDATE
  `;
  if (!owned) throw new NotFoundError('Return order not found');
  if (await tx.commerceReturn.findFirst({ where: { orderId: owned.id, businessId, rejectedAt: null }, select: { id: true } })) {
    throw new ConflictError('Use item-level disposition for this return');
  }
  const order = await tx.order.findFirst({ where: { id: owned.id, businessId, status: 'FULFILLED', stockDeducted: true },
    include: { items: true, commerceQuote: { include: { lines: true } } } });
  if (!order?.commerceQuote?.lines.length || order.commerceQuote.lines.some((line) => line.productMode !== 'TRACKED')) {
    throw new ConflictError('Stock return requires a fulfilled order containing only tracked goods');
  }
  const productIds = order.commerceQuote.lines.map((line) => line.productId);
  await lockCommerceProducts(tx, businessId, productIds);
  const tracked = await tx.product.count({ where: { businessId, id: { in: productIds }, commerceMode: 'TRACKED' } });
  if (tracked !== new Set(productIds).size) throw new ConflictError('A returned item is no longer tracked');
  if (!await claimStockMovement(order.id, businessId, true, tx)) throw new ConflictError('The order stock has already been restored');
  await restoreStockForOrderItems(order.id, businessId, null, order.items, tx, 'Commerce return received');
  const revision = item.revision + 1;
  return tx.commerceCase.update({ where: { id }, data: { state: 'WAITING', revision,
    resolution: 'RETURN_RECEIVED_TO_STOCK', history: { create: {
      state: 'WAITING', revision, resolution: 'RETURN_RECEIVED_TO_STOCK',
    } },
  } });
}
