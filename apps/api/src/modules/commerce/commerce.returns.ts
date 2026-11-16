import { createHash } from 'node:crypto';
import type { CommerceCase, CommerceReturn, Prisma } from '@prisma/client';
import type { z } from 'zod';
import { persistOutboundSend } from '../../queues/outbound.queue.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { requirePaymentActor } from '../payments/payment-relationships.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { loadCommerceSource } from './commerce.quotes.js';
import { lockCommerceProducts } from './commerce.stock.js';
import type { partialReturnInput, returnResolutionInput } from './commerce.contract.js';

type Tx = Prisma.TransactionClient;

export async function openReturnCase(tx: Tx, actor: OrderActor, orderId: string): Promise<CommerceCase> {
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'messages.send');
  await requireStaffMembership(tx, actor);
  if (actor.staffId !== null && actor.role !== 'MANAGER') throw new ForbiddenError('A manager must open an order return');
  const order = await tx.order.findFirst({ where: { id: orderId, businessId: actor.businessId, status: 'FULFILLED', deletedAt: null,
    commerceQuote: { isNot: null } }, select: { customerId: true } });
  if (!order) throw new NotFoundError('Delivered commerce order not found');
  const sourceId = 'owner-return-' + orderId;
  return tx.commerceCase.upsert({ where: { businessId_sourceId: { businessId: actor.businessId, sourceId } }, update: {},
    create: { businessId: actor.businessId, customerId: order.customerId, orderId, sourceId, kind: 'RETURN',
      history: { create: { revision: 0, state: 'OPEN', staffId: actor.staffId } } } });
}

async function lockReturnCase(tx: Tx, actor: OrderActor, caseId: string) {
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'messages.send');
  await requireStaffMembership(tx, actor);
  const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM commerce_cases WHERE id = ${caseId}
    AND "businessId" = ${actor.businessId} FOR UPDATE`;
  if (!locked) throw new NotFoundError('Return case not found');
  const item = await tx.commerceCase.findUniqueOrThrow({ where: { id: caseId } });
  if (actor.staffId && actor.role !== 'MANAGER' && item.assignedStaffId !== actor.staffId) throw new ForbiddenError('Return case is assigned to other staff');
  if (!item.orderId || !['RETURN', 'EXCHANGE'].includes(item.kind)) throw new ConflictError('Return case requires a delivered order');
  const [owned] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${item.orderId}
    AND "businessId" = ${item.businessId} AND "customerId" = ${item.customerId} AND "deletedAt" IS NULL
    AND status = 'FULFILLED' FOR UPDATE`;
  if (!owned) throw new NotFoundError('Delivered commerce order not found');
  const order = await tx.order.findUniqueOrThrow({ where: { id: owned.id }, include: { items: true, commerceQuote: { include: { lines: true } } } });
  if (!order.commerceQuote) throw new ConflictError('Return requires a confirmed commerce order');
  return { item, order };
}

async function returnHistory(tx: Tx, item: CommerceCase, staffId: string | null, resolution: string): Promise<void> {
  const revision = item.revision + 1;
  await tx.commerceCase.update({ where: { id: item.id }, data: { state: 'WAITING', revision, resolution,
    history: { create: { revision, state: 'WAITING', resolution, staffId } } } });
}

export async function verifyPartialReturn(tx: Tx, actor: OrderActor, caseId: string,
  input: z.infer<typeof partialReturnInput>): Promise<CommerceReturn> {
  const { item, order } = await lockReturnCase(tx, actor, caseId);
  const lines = [...input.lines].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
  const hash = createHash('sha256').update(JSON.stringify([caseId, actor.staffId, input.evidence, input.obligation, lines])).digest('hex');
  const prior = await tx.commerceReturn.findUnique({ where: { businessId_requestKey: { businessId: item.businessId, requestKey: input.requestKey } } });
  if (prior) {
    if (prior.requestHash !== hash) throw new ConflictError('Return identity already belongs to different custody evidence');
    return prior;
  }
  if (item.state === 'RESOLVED' || item.revision !== input.revision) throw new ConflictError('Return case status changed');
  if (lines.some((line) => line.condition === 'REVIEW') && input.obligation === 'NONE') {
    throw new ConflictError('Items needing review must retain an outstanding disposition');
  }
  if (await tx.commerceCaseEvent.findFirst({ where: { businessId: item.businessId, resolution: 'RETURN_RECEIVED_TO_STOCK',
    supportCase: { orderId: order.id } }, select: { caseId: true } })) throw new ConflictError('Full return already recorded');
  const totals = await tx.commerceReturnLine.groupBy({ by: ['orderItemId'], where: { orderId: order.id,
    returned: { rejectedAt: null } }, _sum: { quantity: true } });
  for (const line of lines) {
    const original = order.items.find((entry) => entry.id === line.orderItemId);
    const productMode = order.commerceQuote!.lines.find((entry) => entry.productId === original?.productId)?.productMode;
    const received = totals.find((entry) => entry.orderItemId === line.orderItemId)?._sum.quantity ?? 0;
    if (!original || original.quantity.lt(line.quantity + received)) throw new ConflictError('Returned quantities exceed the purchased quantities');
    if (line.condition === 'RESTOCKABLE' && (productMode !== 'TRACKED' || !order.stockDeducted)) {
      throw new ConflictError('Only deducted tracked goods can be returned to available stock');
    }
  }
  const result = await tx.commerceReturn.create({ data: {
    requestKey: input.requestKey, requestHash: hash, businessId: item.businessId, customerId: item.customerId, caseId,
    orderId: order.id, evidence: input.evidence, obligation: input.obligation, verifiedBy: actor.staffId,
    lines: { createMany: { data: lines } },
  } });
  await returnHistory(tx, item, actor.staffId, 'RETURN_AWAITS_OWNER_APPROVAL');
  return result;
}

export async function decidePartialReturn(tx: Tx, owner: OrderActor, caseId: string, id: string, approve: boolean): Promise<CommerceReturn> {
  if (owner.staffId !== null || owner.role !== undefined) throw new ForbiddenError('Only the owner can approve returned goods');
  const { item, order } = await lockReturnCase(tx, owner, caseId);
  const receipt = await tx.commerceReturn.findFirst({ where: { id, caseId, orderId: order.id, businessId: owner.businessId }, include: { lines: true } });
  if (!receipt) throw new NotFoundError('Return receipt not found');
  if ((approve && receipt.approvedAt) || (!approve && receipt.rejectedAt)) return receipt;
  if (item.state === 'RESOLVED' || receipt.approvedAt || receipt.rejectedAt) throw new ConflictError('Return already decided');
  if (!approve) {
    await returnHistory(tx, item, null, 'RETURN_NEEDS_REVIEW');
    return tx.commerceReturn.update({ where: { id }, data: { rejectedAt: new Date() } });
  }
  if (receipt.verifiedBy) {
    await requirePaymentActor(tx, owner.businessId, receipt.verifiedBy, 'messages.send');
    const verifier = await tx.staff.findFirst({ where: { id: receipt.verifiedBy, businessId: owner.businessId }, select: { role: true } });
    if (verifier?.role !== 'MANAGER' && item.assignedStaffId !== receipt.verifiedBy) throw new ConflictError('Return verifier assignment changed');
  }
  const restock = receipt.lines.filter((line) => line.condition === 'RESTOCKABLE');
  const productIds = restock.map((line) => order.items.find((entry) => entry.id === line.orderItemId)!.productId!);
  if (restock.length && !order.stockDeducted) throw new ConflictError('Stock was already restored');
  await lockCommerceProducts(tx, owner.businessId, productIds);
  for (const line of restock) {
    const productId = order.items.find((entry) => entry.id === line.orderItemId)!.productId!;
    const product = await tx.product.findFirst({ where: { id: productId, businessId: owner.businessId, commerceMode: 'TRACKED' } });
    if (!product) throw new ConflictError('Returned product is no longer tracked');
    const balanceAfter = product.stockQuantity.add(line.quantity);
    await tx.product.update({ where: { id: productId }, data: { stockQuantity: balanceAfter } });
    const movement = await tx.stockMovement.create({ data: { type: 'RETURN', productId, orderId: order.id, businessId: owner.businessId,
      quantity: line.quantity, balanceAfter, note: 'Verified item return' } });
    await tx.commerceReturnLine.update({ where: { returnId_orderItemId: { returnId: id, orderItemId: line.orderItemId } },
      data: { movementId: movement.id } });
  }
  const customer = await tx.customer.findFirst({ where: { id: order.customerId, businessId: owner.businessId,
    blacklisted: false, waNumberInvalid: false, deletedAt: null, lastInboundAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { waNumber: true } });
  const noticeId = customer ? await persistOutboundSend(tx, { businessId: owner.businessId, customerId: order.customerId,
    to: customer.waNumber, relatedOrderId: order.id, body: `The shop recorded your returned items for order ${order.referenceNumber}. ` +
      (receipt.obligation === 'NONE' ? 'Contact the shop if you need more help.' : 'The shop is reviewing the remaining action on your case.'),
  }, 'commerce-return-received-' + id) : null;
  await returnHistory(tx, item, null, receipt.obligation === 'NONE' ? 'ITEMS_RECEIVED' : 'RETURN_DISPOSITION_PENDING');
  const approvedAt = new Date();
  return tx.commerceReturn.update({ where: { id }, data: { approvedAt, noticeId, resolvedAt: receipt.obligation === 'NONE' ? approvedAt : null } });
}

export async function finishReturnObligation(tx: Tx, actor: OrderActor, caseId: string, id: string,
  evidence: z.infer<typeof returnResolutionInput>): Promise<CommerceReturn> {
  const { item, order } = await lockReturnCase(tx, actor, caseId);
  const record = await tx.commerceReturn.findFirst({ where: { id, caseId, businessId: actor.businessId, approvedAt: { not: null } },
    include: { resolutionPayment: { select: { voidedAt: true } } } });
  if (!record) throw new NotFoundError('Approved return not found');
  if (record.resolvedAt && !record.resolutionPayment?.voidedAt) return record;
  let paymentId: string | undefined;
  if (record.obligation === 'REFUND_REVIEW') {
    await requirePaymentActor(tx, actor.businessId, actor.staffId, 'payments.verify');
    if (!('paymentId' in evidence)) throw new ConflictError('A verified refund ledger entry is required');
    const [payment] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${evidence.paymentId}
      AND "businessId" = ${actor.businessId} AND "customerId" = ${order.customerId} AND "orderId" = ${order.id}
      AND direction = 'OUT' AND confidence <> 'CLAIMED' AND "voidedAt" IS NULL FOR SHARE`;
    if (!payment) throw new NotFoundError('Recorded refund not found');
    paymentId = payment.id;
    await logActivity({ businessId: actor.businessId, staffId: actor.staffId, action: 'return.refund_evidence_linked',
      resourceId: id, resourceType: 'commerce_return', note: `Ledger entry ${paymentId}` }, tx);
  } else {
    if (!('evidenceMessageId' in evidence)) throw new ConflictError('Customer confirmation is required');
    const source = await loadCommerceSource(tx, item, evidence.evidenceMessageId);
    if (+source.createdAt < +record.approvedAt! - 1000 || source.body?.trim().toUpperCase() !== ('RESOLVED ' + item.id).toUpperCase()) {
      throw new ConflictError('Message does not confirm this return case');
    }
  }
  await returnHistory(tx, item, actor.staffId, paymentId ? 'RECORDED_REFUND_LINKED' : 'CUSTOMER_CONFIRMED_RETURN_DISPOSITION');
  return tx.commerceReturn.update({ where: { id }, data: { resolvedAt: new Date(), ...(paymentId ? { resolutionPaymentId: paymentId } : {}) } });
}
