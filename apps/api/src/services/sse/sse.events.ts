import { SSEManager } from './sse.manager.js';

export interface OrderCreatedPayload {
  orderId: string;
  referenceNumber: string;
  customerName: string | null;
  totalAmount: number;
}

export interface OrderUpdatedPayload {
  orderId: string;
  status: string;
  previousStatus: string;
}

export interface MessageFlaggedPayload {
  messageId: string;
  requiresReview: boolean;
  intent: string;
}

export interface StockAlertPayload {
  productId: string;
  productName: string;
  currentStock: number;
  threshold: number;
}

export interface PaymentConfirmedPayload {
  paymentId: string;
  orderId: string;
  amount: number;
}

export function emitOrderCreated(businessId: string, payload: OrderCreatedPayload): void {
  SSEManager.getInstance().broadcast(businessId, {
    type: 'order.created',
    payload: payload as unknown as Record<string, unknown>,
  });
}

export function emitOrderUpdated(businessId: string, payload: OrderUpdatedPayload): void {
  SSEManager.getInstance().broadcast(businessId, {
    type: 'order.updated',
    payload: payload as unknown as Record<string, unknown>,
  });
}

export function emitMessageFlagged(businessId: string, payload: MessageFlaggedPayload): void {
  SSEManager.getInstance().broadcast(businessId, {
    type: 'message.flagged',
    payload: payload as unknown as Record<string, unknown>,
  });
}

export function emitStockAlert(businessId: string, payload: StockAlertPayload): void {
  SSEManager.getInstance().broadcast(businessId, {
    type: 'stock.alert',
    payload: payload as unknown as Record<string, unknown>,
  });
}

export function emitPaymentConfirmed(businessId: string, payload: PaymentConfirmedPayload): void {
  SSEManager.getInstance().broadcast(businessId, {
    type: 'payment.confirmed',
    payload: payload as unknown as Record<string, unknown>,
  });
}
