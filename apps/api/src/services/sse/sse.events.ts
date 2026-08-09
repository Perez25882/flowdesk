import type {
  MessageFlaggedPayload,
  OrderCreatedPayload,
  OrderUpdatedPayload,
  PaymentConfirmedPayload,
  StockAlertPayload,
} from '@flowdesk/shared';
import { SSEManager } from './sse.manager.js';

// The payload shapes live in `@flowdesk/shared` so the dashboard consumes the
// same declarations the API emits. Re-exported here so existing importers do
// not all have to change their import path.
export type {
  MessageFlaggedPayload,
  OrderCreatedPayload,
  OrderUpdatedPayload,
  PaymentConfirmedPayload,
  StockAlertPayload,
};

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
