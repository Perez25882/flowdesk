import { logger } from '../../config/logger.js';

interface OrderEventPayload {
  id: string;
  referenceNumber: string;
  status: string;
  customerId: string;
  totalAmount: number;
}

export function emitOrderCreated(order: OrderEventPayload, businessId: string): void {
  logger.info(
    { orderId: order.id, referenceNumber: order.referenceNumber, businessId },
    'SSE event: order.created (stub)',
  );
}

export function emitOrderStatusChanged(
  order: OrderEventPayload,
  businessId: string,
  previousStatus: string,
): void {
  logger.info(
    { orderId: order.id, from: previousStatus, to: order.status, businessId },
    'SSE event: order.status_changed (stub)',
  );
}
