import type { OrderStatus } from '@/types/order';

/**
 * What each order status is called on screen, and its colour.
 *
 * The owner-facing names are not the database's: PROCESSING is "Packing",
 * DISPATCHED is "On the way", FULFILLED is "Delivered". They are the words a
 * shop uses out loud, and they are defined once here because the board, the
 * list and the tabs each had their own copy and could drift apart.
 */
export const STATUS_META: Record<OrderStatus, { label: string; dot: string }> = {
  PENDING: { label: 'Pending', dot: 'bg-status-pending' },
  CONFIRMED: { label: 'Confirmed', dot: 'bg-status-confirmed' },
  PROCESSING: { label: 'Packing', dot: 'bg-status-processing' },
  DISPATCHED: { label: 'On the way', dot: 'bg-status-dispatched' },
  FULFILLED: { label: 'Delivered', dot: 'bg-status-fulfilled' },
  CANCELLED: { label: 'Cancelled', dot: 'bg-status-cancelled' },
};

/** The order an order moves through, which is the order the tabs are read in. */
export const ORDER_STATUS_ORDER: readonly OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'DISPATCHED',
  'FULFILLED',
  'CANCELLED',
];
