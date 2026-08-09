/**
 * The realtime event contract, shared by the API and the dashboard.
 *
 * This lives in `shared` rather than being restated on each side because the
 * two had already drifted: the API emitted `order.updated` carrying `orderId`
 * while the dashboard read `payload.id`, so the order-detail cache was
 * invalidated under the key `undefined` and the open drawer never refreshed.
 * A single declaration makes that class of mismatch a type error instead of a
 * silent no-op.
 */

/** Every event type the API broadcasts. The wire format is a named SSE frame. */
export const SSE_EVENT_TYPES = [
  'order.created',
  'order.updated',
  'message.flagged',
  'stock.alert',
  'payment.confirmed',
] as const;

export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

/**
 * Sent once when a stream opens, before any business event. Named separately
 * because it is produced by the connection handler rather than by a domain
 * action, and carries no business payload the dashboard acts on.
 */
export const SSE_CONNECTED_EVENT = 'connected';

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

/** Maps each event type to the payload it carries. */
export interface SSEEventPayloadMap {
  'order.created': OrderCreatedPayload;
  'order.updated': OrderUpdatedPayload;
  'message.flagged': MessageFlaggedPayload;
  'stock.alert': StockAlertPayload;
  'payment.confirmed': PaymentConfirmedPayload;
}

/** A decoded event, discriminated on `type`. */
export type SSEEvent = {
  [K in SSEEventType]: { type: K; payload: SSEEventPayloadMap[K] };
}[SSEEventType];
