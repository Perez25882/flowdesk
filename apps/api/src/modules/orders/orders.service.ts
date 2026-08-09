import { Prisma, type OrderStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { extractItemsFromText } from '../../utils/item-extractor.js';
import { notifyOrderStatus } from '../../services/notifications/customer-notifications.js';
import { recordOrder } from '../../services/plan/plan.service.js';
import { emitOrderCreated, emitOrderUpdated, emitStockAlert } from '../../services/sse/sse.events.js';
import {
  createOrder,
  findOrderById,
  updateOrderStatus,
  generateOrderReference,
  findOrdersByStatus,
  assignOrderToStaff,
  type OrderWithRelations,
  type CreateOrderInput,
  type CreateOrderItemInput,
} from './orders.repository.js';
import {
  findActiveCatalogProducts,
  deductStockForOrderItems,
} from '../products/products.repository.js';
import type { CreateOrderInput as ManualOrderInput } from './orders.schema.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import { upsertCustomerByPhone } from '../customers/customers.service.js';
import { findCustomerById, recalculateCustomerTotals } from '../customers/customers.repository.js';
import { findProductById } from '../products/products.repository.js';

/**
 * Legal order lifecycle transitions. Encoding them in one table means an
 * invalid move is rejected identically wherever it is attempted, instead of
 * relying on each service function to remember its own guard.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['FULFILLED', 'CANCELLED'],
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
  build: (referenceNumber: string) => CreateOrderInput,
): Promise<OrderWithRelations> {
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const referenceNumber = await generateOrderReference(businessId);

    try {
      return await createOrder(build(referenceNumber), undefined);
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
  });
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
): Promise<OrderWithRelations> {
  const catalog = await findActiveCatalogProducts(businessId);
  const extracted = extractItemsFromText(body, catalog);

  const items: CreateOrderItemInput[] =
    extracted.length > 0
      ? toOrderItems(extracted)
      : // Never drop an order because parsing failed — record the raw text and
        // let the owner price it by hand.
        [{ description: body, quantity: 1, unitPrice: 0 }];

  const order = await createOrderWithReference(businessId, (referenceNumber) => ({
    businessId,
    customerId,
    referenceNumber,
    rawMessage: body,
    isManual: false,
    items,
  }));

  await Promise.all([recalculateCustomerTotals(customerId), recordOrder(businessId)]);

  await emitCreated(order);

  logger.info(
    {
      orderId: order.id,
      businessId,
      reference: order.referenceNumber,
      itemCount: items.length,
      matched: extracted.filter((item) => item.matched).length,
      total: Number(order.totalAmount),
    },
    'Order created from customer message',
  );

  return order;
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
): Promise<OrderWithRelations> {
  const order = await createOrderWithReference(businessId, (referenceNumber) => ({
    businessId,
    customerId,
    referenceNumber,
    rawMessage,
    isManual: false,
    items: items.map((item) => ({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
  }));

  await Promise.all([recalculateCustomerTotals(customerId), recordOrder(businessId)]);
  await emitCreated(order);

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

export async function createManualOrder(
  data: ManualOrderInput,
  businessId: string,
): Promise<OrderWithRelations> {
  // Two ways in: an existing customer id, or a phone number for a walk-in that
  // we upsert. The schema guarantees exactly one is present.
  let resolvedCustomerId: string;

  if (data.customerId) {
    // The id must belong to THIS business. Trusting it verbatim let one tenant
    // attach another tenant's customer to an order — leaking that customer's
    // name and phone in the response and injecting a fabricated balance into
    // the victim's books. Ownership is verified before use.
    const customer = await findCustomerById(data.customerId, businessId);
    if (!customer) {
      throw new NotFoundError('Customer not found');
    }
    resolvedCustomerId = customer.id;
  } else {
    const phone = normalizeGhanaPhone(data.customerPhone!);
    const customer = await upsertCustomerByPhone(businessId, phone, data.customerName ?? null);
    resolvedCustomerId = customer.id;
  }

  // Product references are validated the same way — a foreign productId would
  // otherwise be recorded as a "matched" line against another tenant's catalogue.
  const items: CreateOrderItemInput[] = [];
  for (const item of data.items) {
    const base: CreateOrderItemInput = {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
    if (item.productId) {
      const product = await findProductById(item.productId, businessId);
      if (!product) {
        throw new NotFoundError('Product not found');
      }
      base.productId = product.id;
      base.matchConfidence = 1;
    }
    items.push(base);
  }

  const order = await createOrderWithReference(businessId, (referenceNumber) => {
    const input: CreateOrderInput = {
      businessId,
      customerId: resolvedCustomerId,
      referenceNumber,
      rawMessage: data.rawMessage,
      isManual: true,
      items,
    };
    if (data.notes !== undefined) input.notes = data.notes;
    return input;
  });

  await Promise.all([recalculateCustomerTotals(resolvedCustomerId), recordOrder(businessId)]);

  await emitCreated(order);

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

/**
 * The single path for every order status change.
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
  const existing = await findOrderById(orderId, businessId);

  if (!existing) {
    throw new NotFoundError('Order not found');
  }

  if (!ALLOWED_TRANSITIONS[existing.status].includes(next)) {
    throw new ValidationError(
      `Cannot move an order from ${existing.status} to ${next}`,
    );
  }

  if (next === 'CANCELLED' && !options.reason?.trim()) {
    throw new ValidationError('A reason is required when cancelling an order');
  }

  const previousStatus = existing.status;

  if (options.assignStaffId) {
    await assignOrderToStaff(orderId, options.assignStaffId, businessId);
  }

  const note = options.reason ?? `Order moved to ${next}`;
  const order = await updateOrderStatus(orderId, next, actorId, note, undefined);

  if (next === 'CANCELLED' && options.reason) {
    await prisma.order.update({
      where: { id: orderId },
      data: { cancelReason: options.reason },
    });
  }

  // Stock leaves inventory at CONFIRMED, not at PENDING: an unconfirmed order
  // must not deplete stock the owner has not agreed to sell.
  if (next === 'CONFIRMED' && !order.stockDeducted) {
    const alerts = await deductStockForOrderItems(
      orderId,
      businessId,
      actorId,
      order.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        matched: item.matched,
      })),
    );

    await prisma.order.update({
      where: { id: orderId },
      data: { stockDeducted: true },
    });

    for (const alert of alerts) {
      emitStockAlert(businessId, alert);
    }
  }

  // A status change moves the order in or out of the billable set, so the
  // customer's outstanding balance has to be recomputed.
  await recalculateCustomerTotals(order.customerId);

  emitOrderUpdated(businessId, {
    orderId: order.id,
    status: order.status,
    previousStatus,
  });

  await notifyOrderStatus(order.id, next);

  // Staff activity is a staff-only audit trail — `StaffActivity.staffId` is a
  // foreign key to Staff, and the owner has no staff row. Calling this with a
  // placeholder id threw a constraint error that the `.catch` below swallowed,
  // so owner transitions were silently never recorded. Skipped explicitly now.
  if (actorId) {
    await logActivity({
      staffId: actorId,
      action: `order.${next.toLowerCase()}`,
      resourceId: orderId,
      resourceType: 'order',
      note: `Order ${order.referenceNumber} → ${next}${options.reason ? `: ${options.reason}` : ''}`,
    }).catch(() => {});
  }

  return order;
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

export async function fulfillOrder(
  orderId: string,
  businessId: string,
  staffId: string | null,
): Promise<OrderWithRelations> {
  return transitionOrder(orderId, businessId, staffId, 'FULFILLED');
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
