import { createHash } from 'node:crypto';
import { Prisma, type OrderStatus } from '@prisma/client';
import { cancelCommerceOrder, prepareForDelivery, requireCommercePreparation } from '../commerce/commerce.fulfillment.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { extractItemsFromText } from '../../utils/item-extractor.js';
import { recordOrder } from '../../services/plan/plan.service.js';
import { notifyOwnerNewOrder } from '../../services/notifications/owner-notifications.js';
import { emitOrderCreated, emitOrderUpdated, emitStockAlert } from '../../services/sse/sse.events.js';
import {
  createOrder,
  findOrderById,
  updateOrderStatus,
  claimStockMovement,
  generateOrderReference,
  findOrdersByStatus,
  assignOrderToStaff,
  getOrderCountStats,
  getOrderStats,
  type DateRange,
  type OrderStats,
  type OrderWithRelations,
  type CreateOrderInput,
  type CreateOrderItemInput,
} from './orders.repository.js';
import {
  findActiveCatalogProducts,
  findCatalogProductsWithStock,
  deductStockForOrderItems,
  restoreStockForOrderItems,
} from '../products/products.repository.js';
import type { CreateOrderInput as ManualOrderInput } from './orders.schema.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import { recalculateCustomerTotals, upsertCustomerByPhone } from '../customers/customers.repository.js';
import { lockCustomerForTotals } from '../customers/customers.repository.js';
import { buildLadder } from '../../services/pricing/ladder.js';
import { approvedNegotiatedPrice, displayLabel, explicitOrderRequest, hasPolicyOverride, mentioned } from '../../services/assistant/commitment.js';
import {
  lockOrderForDelivery,
  orderActorHasCapability,
  orderAssignmentScope,
  requireStaffMembership,
  type OrderActor,
} from './orders.authorization.js';

/**
 * Legal order lifecycle transitions. Encoding them in one table means an
 * invalid move is rejected identically wherever it is attempted, instead of
 * relying on each service function to remember its own guard.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  // PROCESSING keeps its direct route to FULFILLED: a shop where the customer
  // collects in person never dispatches anything, and forcing those orders
  // through a shipment they do not have would be a worse lie than the missing
  // step it was meant to fix.
  PROCESSING: ['DISPATCHED', 'FULFILLED', 'CANCELLED'],
  // Cancelling after dispatch is allowed because goods do come back. What is
  // not allowed is reversing into PROCESSING: once a rider has it, "being
  // packed" is no longer true of it.
  DISPATCHED: ['FULFILLED', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
};

/** A unique-constraint violation on (businessId, referenceNumber). */
function isReferenceCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target ?? '').includes('referenceNumber')
  );
}

/**
 * Creates an order, regenerating the reference if another writer claimed it
 * first. The Redis counter makes this rare, but two workers racing on a freshly
 * seeded counter can still collide, and losing a customer's order to a 500 is
 * not an acceptable outcome.
 */
async function createOrderWithReference(
  businessId: string,
  create: (referenceNumber: string) => Promise<OrderWithRelations>,
): Promise<OrderWithRelations> {
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const referenceNumber = await generateOrderReference(businessId);

    try {
      return await create(referenceNumber);
    } catch (error: unknown) {
      if (!isReferenceCollision(error)) throw error;
      lastError = error;
      logger.warn({ businessId, referenceNumber, attempt }, 'Order reference collision — retrying');
    }
  }

  throw lastError;
}

function toOrderItems(
  items: Array<{
    productId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    confidence: number;
  }>,
): CreateOrderItemInput[] {
  return items.map((item) => {
    const base: CreateOrderItemInput = {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
    if (item.productId) {
      base.productId = item.productId;
      base.matchConfidence = item.confidence;
    }
    return base;
  });
}

async function emitCreated(order: OrderWithRelations): Promise<void> {
  emitOrderCreated(order.businessId, {
    orderId: order.id,
    referenceNumber: order.referenceNumber,
    customerName: order.customer?.name ?? null,
    totalAmount: Number(order.totalAmount),
    // Carried so the realtime fan-out can make the same assignment-scoped
    // decision the HTTP layer makes; without it a delivery rider is either sent
    // every order in the shop or none of them.
    assignedStaffId: order.assignedStaffId ?? null,
  });

  // The owner is on WhatsApp, not on a dashboard. The PRD rates "owner never
  // checks the dashboard" as the highest product risk and names this as the
  // mitigation. A manual order was typed by the owner a moment ago, so telling
  // them about it is noise.
  if (!order.isManual) {
    await notifyOwnerNewOrder(order.id);
  }
}

/**
 * Builds an order from an inbound WhatsApp message.
 *
 * Deliberately does NOT message the customer: the intent worker owns that, via
 * the notification service, so exactly one confirmation is sent per order.
 */
export async function createOrderFromMessage(
  body: string,
  businessId: string,
  customerId: string,
  messageId: string,
): Promise<{ order: OrderWithRelations; created: boolean }> {
  const referenceNumber = await generateOrderReference(businessId);
  const result = await prisma.$transaction(async (tx) => {
    const source = await lockInboundOrderSource(tx, businessId, customerId, messageId, body);
    const existing = await recoverInboundOrder(tx, businessId, customerId, source.relatedOrderId);
    if (existing) return { order: existing, created: false };
    const [business] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM businesses WHERE id = ${businessId} AND active AND "deletedAt" IS NULL
        AND "deactivatedAt" IS NULL AND "aiAssistMode" = 'OFF' FOR SHARE
    `;
    if (!business || !explicitOrderRequest(body) || hasPolicyOverride(body)) {
      throw new ForbiddenError('Inbound order is outside the current policy');
    }
    await tx.$queryRaw`SELECT id FROM products WHERE "businessId" = ${businessId} AND active AND "deletedAt" IS NULL ORDER BY id FOR SHARE`;
    const extracted = extractItemsFromText(body, await findActiveCatalogProducts(businessId, tx));
    const items = extracted.length ? toOrderItems(extracted) : [{ description: body, quantity: 1, unitPrice: 0 }];
    const order = await createOrder({
      businessId, customerId, referenceNumber, rawMessage: body, isManual: false, items, inboundSourceMessageId: messageId,
    }, tx);
    await tx.message.update({ where: { id: messageId }, data: { relatedOrderId: order.id } });
    await recalculateCustomerTotals(customerId, tx);
    return { order, created: true };
  }, { timeout: 10_000 });
  if (result.created) await Promise.allSettled([recordOrder(businessId), emitCreated(result.order)]);
  return result;
}

async function lockInboundOrderSource(
  tx: Prisma.TransactionClient,
  businessId: string,
  customerId: string,
  messageId: string,
  body: string,
): Promise<{ relatedOrderId: string | null }> {
  const customer = await lockCustomerForTotals(tx, customerId, businessId);
  if (!customer || customer.deletedAt) throw new NotFoundError('Customer not found');
  const [source] = await tx.$queryRaw<Array<{ relatedOrderId: string | null }>>`
    SELECT m."relatedOrderId" FROM messages m JOIN customers c ON c.id = m."customerId"
    WHERE m.id = ${messageId} AND m."businessId" = ${businessId} AND m."customerId" = ${customerId}
      AND m.direction = 'INBOUND' AND m.body = ${body} AND c."businessId" = ${businessId} AND NOT c.blacklisted
    FOR UPDATE OF m
  `;
  if (!source) throw new NotFoundError('Inbound message not found');
  return source;
}

async function recoverInboundOrder(
  tx: Prisma.TransactionClient,
  businessId: string,
  customerId: string,
  orderId: string | null,
): Promise<OrderWithRelations | null> {
  if (!orderId) return null;
  const prior = await findOrderById(orderId, businessId, { tx });
  if (!prior || prior.customerId !== customerId) throw new ConflictError('Inbound order cannot be recovered');
  return prior;
}

export interface AssistantOrderItem {
  productId: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Creates an order the assistant has settled over several turns.
 *
 * Separate from `createOrderFromMessage` because there is nothing left to
 * extract: the items were resolved against the catalogue across the
 * conversation, and re-parsing the last message ("2 bags") would throw that away
 * and produce an unpriced line instead.
 *
 * `rawMessage` carries the conversation's own words so the owner can still see
 * what was actually asked for.
 */
export async function createOrderFromAssistant(
  businessId: string,
  customerId: string,
  items: AssistantOrderItem[],
  rawMessage: string,
  source: { messageId: string; pendingOrderId?: string },
): Promise<OrderWithRelations> {
  const referenceNumber = await generateOrderReference(businessId);
  const { order, created } = await prisma.$transaction(async (tx) => {
    const message = await lockInboundOrderSource(tx, businessId, customerId, source.messageId, rawMessage);
    const prior = await recoverInboundOrder(tx, businessId, customerId, message.relatedOrderId);
    if (prior) return { order: prior, created: false };
    if (source.pendingOrderId) {
      const pending = await tx.pendingOrder.findFirst({ where: { id: source.pendingOrderId, businessId, customerId,
        status: 'AWAITING_REPLY', expiresAt: { gt: new Date() } }, select: { id: true } });
      if (!pending) throw new ConflictError('Pending order expired or was resolved');
    }
    const [business] = await tx.$queryRaw<Array<{ aiAssistMode: string; bargainingEnabled: boolean }>>`
      SELECT "aiAssistMode"::text, "bargainingEnabled" FROM businesses WHERE id = ${businessId}
        AND active AND "deletedAt" IS NULL AND "deactivatedAt" IS NULL
        AND ("aiAssistMode" = 'GROUNDED_AUTO' OR ("aiAssistMode" = 'AUTONOMOUS' AND "autonomyAcceptedAt" IS NOT NULL)) FOR SHARE
    `;
    if (!business || !explicitOrderRequest(rawMessage) || hasPolicyOverride(rawMessage)) {
      throw new ForbiddenError('Assistant order is outside the current policy');
    }
    const ids = items.map(({ productId }) => productId);
    if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new ValidationError('Order items are ambiguous');
    await tx.$queryRaw`SELECT id FROM products WHERE "businessId" = ${businessId} AND active AND "deletedAt" IS NULL ORDER BY id FOR SHARE`;
    const catalog = await findCatalogProductsWithStock(businessId, tx);
    const extracted = extractItemsFromText(rawMessage, catalog);
    if (extracted.length !== items.length) throw new ConflictError('Order catalogue evidence changed');
    const verified = items.map((item) => {
      const product = catalog.find((row) => row.id === item.productId);
      const evidence = extracted.find((row) => row.productId === item.productId && row.matched && row.confidence === 1);
      const ambiguous = product && !mentioned(rawMessage, product.name) && product.aliases.some((alias) =>
        mentioned(rawMessage, alias) && catalog.some((other) => other.id !== product.id &&
          [other.name, ...other.aliases].some((term) => term.toLowerCase() === alias.toLowerCase())));
      if (!product || !evidence || evidence.quantity !== item.quantity || product.stockQuantity < item.quantity || !displayLabel(product.name) ||
          ambiguous) {
        throw new ConflictError('Order quantity or inventory is unverified');
      }
      const ladder = buildLadder({ ...product, bargainingEnabled: business.bargainingEnabled });
      if (!approvedNegotiatedPrice({ ...product, ladder }, item.quantity, item.unitPrice)) throw new ConflictError('Order price changed');
      return { ...item, description: product.name };
    });
    const order = await createOrder({ businessId, customerId, referenceNumber, rawMessage, isManual: false,
      items: verified, inboundSourceMessageId: source.messageId }, tx);
    await tx.message.update({ where: { id: source.messageId }, data: { relatedOrderId: order.id } });
    if (source.pendingOrderId && !(await tx.pendingOrder.updateMany({
      where: { id: source.pendingOrderId, businessId, customerId, status: 'AWAITING_REPLY', expiresAt: { gt: new Date() } },
      data: { status: 'RESOLVED', resolvedOrderId: order.id },
    })).count) throw new ConflictError('Pending order expired or was resolved');
    await recalculateCustomerTotals(customerId, tx);
    return { order, created: true };
  });

  if (created) {
    const effects = await Promise.allSettled([recordOrder(businessId), emitCreated(order)]);
    if (effects.some((effect) => effect.status === 'rejected')) {
      logger.warn({ orderId: order.id, businessId }, 'Assistant order committed with pending secondary effects');
    }
  }

  logger.info(
    {
      orderId: order.id,
      businessId,
      reference: order.referenceNumber,
      itemCount: items.length,
      total: Number(order.totalAmount),
    },
    'Order created by the assistant',
  );

  return order;
}

function manualOrderPrefix(businessId: string, key: string): string {
  return 'manual-' + createHash('sha256').update(businessId + ':' + key).digest('hex').slice(0, 32) + '-';
}

export async function findManualOrderRequest(businessId: string, key: string, tx: Prisma.TransactionClient = prisma) {
  return tx.order.findFirst({ where: { businessId, isManual: true, id: { startsWith: manualOrderPrefix(businessId, key) } },
    select: { id: true, deletedAt: true } });
}

async function manualOrderInput(
  data: ManualOrderInput,
  businessId: string,
  referenceNumber: string,
  tx?: Prisma.TransactionClient,
): Promise<CreateOrderInput> {
  const db = tx ?? prisma;
  const customer = data.customerId
    ? await db.customer.findFirst({ where: { id: data.customerId, businessId, deletedAt: null }, select: { id: true } })
    : await upsertCustomerByPhone(businessId, normalizeGhanaPhone(data.customerPhone!), data.customerName ?? null, tx);
  if (!customer) throw new NotFoundError('Customer not found');
  const ids = [...new Set(data.items.flatMap((item) => item.productId ? [item.productId] : []))];
  if (ids.length && await db.product.count({ where: { id: { in: ids }, businessId, deletedAt: null } }) !== ids.length) {
    throw new NotFoundError('Product not found');
  }
  return { businessId, customerId: customer.id, referenceNumber, rawMessage: data.rawMessage, isManual: true,
    items: data.items.map((item) => ({ ...item, ...(item.productId ? { matchConfidence: 1 } : {}) })),
    ...(data.notes !== undefined ? { notes: data.notes } : {}) };
}

export async function createManualOrder(data: ManualOrderInput, businessId: string, actor?: OrderActor): Promise<OrderWithRelations> {
  let created = true;
  const requestKey = data.requestKey;
  const order = await createOrderWithReference(businessId, async (referenceNumber) => {
    if (!requestKey) return createOrder(await manualOrderInput(data, businessId, referenceNumber));
    const prefix = manualOrderPrefix(businessId, requestKey);
    const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
    const id = prefix + digest;
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${prefix}, 0))`;
      if (actor) await requireStaffMembership(tx, actor);
      const prior = await findManualOrderRequest(businessId, requestKey, tx);
      if (prior) {
        if (prior.id !== id || prior.deletedAt) throw new ConflictError('This request already belongs to a different or closed order');
        const existing = await findOrderById(prior.id, businessId, { tx });
        if (!existing) throw new ConflictError('This order can no longer be opened');
        created = false;
        return existing;
      }
      const input = await manualOrderInput(data, businessId, referenceNumber, tx);
      const customer = await lockCustomerForTotals(tx, input.customerId, businessId);
      if (!customer || customer.deletedAt) throw new NotFoundError('Customer not found');
      const saved = await createOrder({ ...input, id }, tx);
      await recalculateCustomerTotals(input.customerId, tx);
      return saved;
    });
  });

  if (created) {
    if (!requestKey) await recalculateCustomerTotals(order.customerId);
    await Promise.all([recordOrder(businessId), emitCreated(order)]);
  }

  // Manual orders get no auto-reply: the customer may have ordered in person and
  // an unexpected WhatsApp message would be confusing.
  return order;
}

interface TransitionOptions {
  /** Required when cancelling. */
  reason?: string;
  /** Staff member to assign as part of the transition. */
  assignStaffId?: string;
}

function validateTransition(previousStatus: OrderStatus, next: OrderStatus): void {
  if (!ALLOWED_TRANSITIONS[previousStatus].includes(next)) {
    throw new ValidationError(`Cannot move an order from ${previousStatus} to ${next}`);
  }
}

/**
 * Applies commercial order transitions, including inventory movement.
 *
 * Consolidating the transitions guarantees that validation, stock movement,
 * customer-total recalculation, the WhatsApp notification, the SSE broadcast
 * and the audit entry all happen for every transition — previously each
 * function implemented its own subset and customers were never notified.
 */
async function transitionOrder(
  orderId: string,
  businessId: string,
  actorId: string | null,
  next: OrderStatus,
  options: TransitionOptions = {},
): Promise<OrderWithRelations> {
  if (next === 'CANCELLED' && !options.reason?.trim()) throw new ValidationError('A reason is required when cancelling an order');
  const result = await prisma.$transaction(async (tx) => {
    const target = await findOrderById(orderId, businessId, { tx });
    if (!target || !await lockCustomerForTotals(tx, target.customerId, businessId)) throw new NotFoundError('Order not found');
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} AND "businessId" = ${businessId} AND "deletedAt" IS NULL FOR UPDATE`;
    const existing = await findOrderById(orderId, businessId, { tx });
    if (!existing) throw new NotFoundError('Order not found');
    if (actorId) {
      const [actor] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM staff WHERE id = ${actorId} AND "businessId" = ${businessId} AND active
          AND role IN ('MANAGER','OPERATIONS') FOR SHARE
      `;
      if (!actor) throw new ForbiddenError('You do not have permission to perform this action');
    }
    if (existing.status === next) return { order: existing, previous: next, alerts: [] };
    if (next === 'CANCELLED' && existing.status === 'DISPATCHED') {
      const shipment = await tx.shipment.findUnique({ where: { orderId }, select: { businessId: true, deliveredAt: true } });
      if (!shipment || shipment.businessId !== businessId || shipment.deliveredAt) {
        throw new ConflictError('The shipment requires review before cancellation');
      }
    }
    validateTransition(existing.status, next);
    if (next === 'PROCESSING') await requireCommercePreparation(tx, businessId, orderId);
    if (next === 'CANCELLED') await cancelCommerceOrder(tx, businessId, existing.customerId, orderId, existing.status);
    if (options.assignStaffId) await assignOrderToStaff(orderId, options.assignStaffId, businessId, tx);
    const order = await updateOrderStatus(orderId, businessId, next, actorId, options.reason ?? `Order moved to ${next}`,
      existing.status, options.reason ?? null, tx);
    if (!order) throw new ConflictError('The order changed during transition');
    const items = order.items.map(({ productId, quantity, matched }) => ({ productId, quantity, matched }));
    const ids = items.flatMap((item) => item.productId ? [item.productId] : []);
    if (ids.length && (next === 'CANCELLED' || next === 'CONFIRMED')) {
      await tx.$queryRaw`SELECT id FROM products WHERE "businessId" = ${businessId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    }
    const alerts = next === 'CONFIRMED' && await claimStockMovement(orderId, businessId, false, tx)
      ? await deductStockForOrderItems(orderId, businessId, actorId, items, tx) : [];
    if (next === 'CANCELLED' && await claimStockMovement(orderId, businessId, true, tx)) {
      await restoreStockForOrderItems(orderId, businessId, actorId, items, tx);
    }
    await recalculateCustomerTotals(order.customerId, tx);
    await tx.fulfillmentTask.create({ data: { businessId, orderId, kind: 'NOTIFY', subject: next } });
    await logActivity({ staffId: actorId, businessId, action: `order.${next.toLowerCase()}`,
      resourceId: orderId, resourceType: 'order', note: `Order ${order.referenceNumber} → ${next}` }, tx);
    return { order: (await findOrderById(orderId, businessId, { tx })) ?? order, previous: existing.status, alerts };
  }, { timeout: 10_000 });
  if (result.previous !== next) emitOrderUpdated(businessId, { orderId, status: next, previousStatus: result.previous });
  for (const alert of result.alerts) {
    emitStockAlert(businessId, alert);
  }
  return result.order;
}

/**
 * The actor on a transition is a staff id, or null when the owner did it.
 *
 * Null rather than a placeholder string: `assignedStaffId` and the audit trail
 * are real foreign keys, so a sentinel like `'system'` fails the constraint. It
 * did exactly that — an owner moving an order to Packing hit a 500 every time,
 * because the transition tried to assign the order to a staff row named
 * "system" that cannot exist.
 */
export async function confirmOrder(
  orderId: string,
  businessId: string,
  confirmedBy: string | null,
): Promise<OrderWithRelations> {
  return transitionOrder(orderId, businessId, confirmedBy, 'CONFIRMED');
}

/**
 * The assignment a transition should apply for a given actor.
 *
 * Exported for tests. `Order.assignedStaffId` is a foreign key to Staff, so it
 * only ever accepts a real staff id — never a placeholder for "the owner".
 */
export function assignmentFor(staffId: string | null): { assignStaffId?: string } {
  return staffId ? { assignStaffId: staffId } : {};
}

export async function markProcessing(
  orderId: string,
  businessId: string,
  staffId: string | null,
): Promise<OrderWithRelations> {
  // Packing an order claims it, but only a real staff member can be assigned.
  return transitionOrder(orderId, businessId, staffId, 'PROCESSING', assignmentFor(staffId));
}

/** Authorize and persist delivery changes under the order's reassignment lock. */
export async function transitionDeliveryOrder<T>(
  orderId: string,
  actor: OrderActor,
  next: 'DISPATCHED' | 'FULFILLED',
  updateShipment: (tx: Prisma.TransactionClient, order: OrderWithRelations) => Promise<T>,
  allowAlreadyFulfilled = false,
): Promise<{ order: OrderWithRelations; shipment: T }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockOrderForDelivery(tx, orderId, actor);
    const existing = await findOrderById(orderId, actor.businessId, { tx });
    if (!existing) throw new NotFoundError('Order not found');

    const replay = existing.status === next && (next === 'DISPATCHED' || allowAlreadyFulfilled);
    if (!replay) {
      validateTransition(existing.status, next);
      await prepareForDelivery(tx, actor, orderId, next, existing.status);
    }

    const shipment = await updateShipment(tx, existing);
    const order = replay ? existing : await updateOrderStatus(
      orderId, actor.businessId, next, actor.staffId, `Order moved to ${next}`, existing.status, null, tx,
    );
    if (!order) throw new ConflictError('The order changed during delivery');

    if (!replay) {
      await tx.fulfillmentTask.create({ data: { businessId: actor.businessId, orderId, kind: 'NOTIFY', subject: next } });
      await logActivity({ staffId: actor.staffId, businessId: actor.businessId, action: `order.${next.toLowerCase()}`,
        resourceId: orderId, resourceType: 'order', note: `Order ${order.referenceNumber} → ${next}` }, tx);
    }
    return { order, shipment, previousStatus: existing.status };
  });

  if (result.previousStatus !== next) {
    emitOrderUpdated(actor.businessId, { orderId, status: next, previousStatus: result.previousStatus });
  }
  return { order: result.order, shipment: result.shipment };
}

export async function fulfillOrder(
  orderId: string,
  actor: OrderActor,
): Promise<OrderWithRelations> {
  const { order } = await transitionDeliveryOrder(orderId, actor, 'FULFILLED', async (tx, current) => {
    if (current.status !== 'DISPATCHED') return;
    const shipment = await tx.shipment.updateMany({ where: { orderId, businessId: actor.businessId, deliveredAt: null },
      data: { deliveredAt: new Date() } });
    if (!shipment.count) throw new ConflictError('Dispatched order has no active shipment');
  }, true);
  return order;
}

export async function getAuthorizedOrderStats(actor: OrderActor, dateRange: DateRange): Promise<OrderStats> {
  if (!orderActorHasCapability(actor, 'orders.read')) {
    throw new ForbiddenError('You do not have permission to perform this action');
  }
  await requireStaffMembership(prisma, actor);
  if (orderActorHasCapability(actor, 'revenue.read')) {
    return getOrderStats(actor.businessId, dateRange);
  }
  return getOrderCountStats(actor.businessId, dateRange, orderAssignmentScope(actor));
}

export async function cancelOrder(
  orderId: string,
  businessId: string,
  reason: string,
  cancelledBy: string | null,
): Promise<OrderWithRelations> {
  return transitionOrder(orderId, businessId, cancelledBy, 'CANCELLED', { reason });
}

export async function getOrdersByStatus(
  businessId: string,
  status: OrderStatus,
  staffId?: string,
): Promise<OrderWithRelations[]> {
  return findOrdersByStatus(businessId, status, staffId);
}
