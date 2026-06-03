import type { OrderStatus } from '../../types/prisma-enums.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { extractItemsFromText } from '../../utils/item-extractor.js';
import { sendWhatsAppMessage } from '../../services/whatsapp/outbound.js';
import { emitOrderCreated, emitOrderUpdated, emitStockAlert } from '../../services/sse/sse.events.js';
import type { ParsedIncomingMessage } from '../webhook/webhook.types.js';
import {
  createOrder,
  findOrderById,
  updateOrderStatus,
  generateOrderReference,
  findOrdersByStatus,
  assignOrderToStaff,
  type OrderWithRelations,
  type CreateOrderInput,
} from './orders.repository.js';
import {
  findActiveCatalogProducts,
  deductStockForOrderItems,
} from '../products/products.repository.js';
import type { CreateOrderInput as ManualOrderInput } from './orders.schema.js';
import { logActivity } from '../staff/staff-activity.repository.js';

export async function createOrderFromMessage(
  message: ParsedIncomingMessage,
  businessId: string,
  customerId: string,
): Promise<OrderWithRelations> {
  const body = message.body ?? '';

  const catalogProducts = await findActiveCatalogProducts(businessId);

  const extractedItems = extractItemsFromText(body, catalogProducts);

  const orderItems = extractedItems.map((item) => {
    const base = {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
    return item.productId ? { ...base, productId: item.productId } : base;
  });

  if (orderItems.length === 0) {
    orderItems.push({
      description: body,
      quantity: 1,
      unitPrice: 0,
    });
  }

  const referenceNumber = await generateOrderReference(businessId);

  const order = await createOrder(
    {
      businessId,
      customerId,
      referenceNumber,
      rawMessage: body,
      isManual: false,
      items: orderItems,
    },
    undefined,
  );

  try {
    await sendWhatsAppMessage(
      message.from,
      `Thank you! Your order ${order.referenceNumber} has been received. We will confirm it shortly.`,
      businessId,
    );
  } catch (error: unknown) {
    logger.error({ error, orderId: order.id }, 'Failed to send order confirmation auto-reply');
  }

  emitOrderCreated(businessId, {
    orderId: order.id,
    referenceNumber: order.referenceNumber,
    customerName: null,
    totalAmount: Number(order.totalAmount),
  });

  return order;
}

export async function confirmOrder(
  orderId: string,
  businessId: string,
  confirmedBy: string,
): Promise<OrderWithRelations> {
  const existing = await findOrderById(orderId, businessId);
  if (!existing) {
    throw new NotFoundError('Order not found');
  }

  if (existing.status !== 'PENDING') {
    throw new ValidationError(`Cannot confirm order in ${existing.status} status`);
  }

  const previousStatus = existing.status;

  const order = await updateOrderStatus(orderId, 'CONFIRMED', confirmedBy, 'Order confirmed by staff', undefined);

  if (!order.stockDeducted) {
    const alerts = await deductStockForOrderItems(
      orderId,
      businessId,
      confirmedBy,
      order.items,
    );

    for (const alert of alerts) {
      emitStockAlert(businessId, alert);
    }
  }

  emitOrderUpdated(businessId, {
    orderId: order.id,
    status: order.status,
    previousStatus,
  });

  await logActivity({
    staffId: confirmedBy,
    action: 'order.confirmed',
    resourceId: orderId,
    resourceType: 'order',
    note: `Order ${order.referenceNumber} confirmed`,
  }).catch(() => {});

  return order;
}

export async function markProcessing(
  orderId: string,
  businessId: string,
  staffId: string,
): Promise<OrderWithRelations> {
  const existing = await findOrderById(orderId, businessId);
  if (!existing) {
    throw new NotFoundError('Order not found');
  }

  if (existing.status !== 'CONFIRMED') {
    throw new ValidationError(`Cannot mark as processing from ${existing.status} status`);
  }

  const previousStatus = existing.status;

  await assignOrderToStaff(orderId, staffId, businessId);

  const order = await updateOrderStatus(orderId, 'PROCESSING', staffId, 'Order assigned and processing started', undefined);

  emitOrderUpdated(businessId, {
    orderId: order.id,
    status: order.status,
    previousStatus,
  });

  await logActivity({
    staffId,
    action: 'order.processing',
    resourceId: orderId,
    resourceType: 'order',
    note: `Order ${order.referenceNumber} marked as processing`,
  }).catch(() => {});

  return order;
}

export async function fulfillOrder(
  orderId: string,
  businessId: string,
  staffId: string,
): Promise<OrderWithRelations> {
  const existing = await findOrderById(orderId, businessId);
  if (!existing) {
    throw new NotFoundError('Order not found');
  }

  if (existing.status !== 'PROCESSING') {
    throw new ValidationError(`Cannot fulfill order in ${existing.status} status`);
  }

  const previousStatus = existing.status;
  const order = await updateOrderStatus(orderId, 'FULFILLED', staffId, 'Order fulfilled', undefined);

  emitOrderUpdated(businessId, {
    orderId: order.id,
    status: order.status,
    previousStatus,
  });

  await logActivity({
    staffId,
    action: 'order.fulfilled',
    resourceId: orderId,
    resourceType: 'order',
    note: `Order ${order.referenceNumber} fulfilled`,
  }).catch(() => {});

  return order;
}

export async function cancelOrder(
  orderId: string,
  businessId: string,
  reason: string,
  cancelledBy: string,
): Promise<OrderWithRelations> {
  const existing = await findOrderById(orderId, businessId);
  if (!existing) {
    throw new NotFoundError('Order not found');
  }

  if (existing.status === 'CANCELLED') {
    throw new ValidationError('Order is already cancelled');
  }

  if (existing.status === 'FULFILLED') {
    throw new ValidationError('Cannot cancel a fulfilled order');
  }

  const previousStatus = existing.status;
  const order = await updateOrderStatus(orderId, 'CANCELLED', cancelledBy, reason, undefined);

  emitOrderUpdated(businessId, {
    orderId: order.id,
    status: order.status,
    previousStatus,
  });

  await logActivity({
    staffId: cancelledBy,
    action: 'order.cancelled',
    resourceId: orderId,
    resourceType: 'order',
    note: `Order ${order.referenceNumber} cancelled: ${reason}`,
  }).catch(() => {});

  return order;
}

export async function createManualOrder(
  data: ManualOrderInput,
  businessId: string,
): Promise<OrderWithRelations> {
  const referenceNumber = await generateOrderReference(businessId);

  const orderItems = data.items.map((item) => {
    const base = {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
    return item.productId ? { ...base, productId: item.productId } : base;
  });

  const createData: CreateOrderInput = {
    businessId,
    customerId: data.customerId,
    referenceNumber,
    rawMessage: data.rawMessage,
    isManual: true,
    items: orderItems,
  };
  if (data.notes !== undefined) createData.notes = data.notes;

  const order = await createOrder(createData, undefined);

  emitOrderCreated(businessId, {
    orderId: order.id,
    referenceNumber: order.referenceNumber,
    customerName: null,
    totalAmount: Number(order.totalAmount),
  });

  return order;
}

export async function getOrdersByStatus(
  businessId: string,
  status: OrderStatus,
): Promise<OrderWithRelations[]> {
  return findOrdersByStatus(businessId, status);
}
