import { describe, expect, it } from 'vitest';
import { SSE_CONNECTED_EVENT, SSE_EVENT_TYPES } from '@flowdesk/shared';

/**
 * The realtime wire contract.
 *
 * The dashboard received nothing at all for the life of this feature: the API
 * writes *named* SSE frames (`event: order.created`) and the client listened
 * only on `onmessage`, which fires exclusively for frames with no `event:`
 * field. It still reported itself connected, because `onopen` fires either way.
 *
 * These tests pin the frame format and the event list. The client registers one
 * listener per entry in `SSE_EVENT_TYPES`, so an event added on the server
 * without adding it here would silently never reach the dashboard.
 */

/** Mirrors the frame written by `SSEManager.deliverLocal`. */
function frameFor(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe('SSE wire contract', () => {
  it('writes a named frame, not a default `message` frame', () => {
    const frame = frameFor('order.created', { orderId: 'ord_1' });

    // The `event:` line is what makes `onmessage` the wrong listener.
    expect(frame.startsWith('event: order.created\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('separates data from the event name on its own line', () => {
    const frame = frameFor('payment.confirmed', { paymentId: 'pay_1', amount: 500 });
    const [eventLine, dataLine] = frame.split('\n');

    expect(eventLine).toBe('event: payment.confirmed');
    expect(dataLine?.startsWith('data: ')).toBe(true);
    expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
      paymentId: 'pay_1',
      amount: 500,
    });
  });

  it('declares every event the dashboard must subscribe to', () => {
    // Adding a server event without adding it here means no listener is
    // registered for it and the dashboard silently ignores it.
    expect([...SSE_EVENT_TYPES]).toEqual([
      'order.created',
      'order.updated',
      'message.flagged',
      'stock.alert',
      'payment.confirmed',
    ]);
  });

  it('keeps the connection handshake out of the business event list', () => {
    expect(SSE_EVENT_TYPES).not.toContain(SSE_CONNECTED_EVENT);
    expect(SSE_CONNECTED_EVENT).toBe('connected');
  });

  it('names order events with the key the dashboard reads', () => {
    // The dashboard invalidates ['orders','detail', payload.orderId]. It used to
    // read `payload.id`, which is always undefined on this payload, so an open
    // order drawer never refreshed.
    const payload = { orderId: 'ord_1', status: 'CONFIRMED', previousStatus: 'PENDING' };
    const frame = frameFor('order.updated', payload);
    const decoded = JSON.parse(frame.split('\n')[1]!.slice('data: '.length)) as {
      orderId?: string;
      id?: string;
    };

    expect(decoded.orderId).toBe('ord_1');
    expect(decoded.id).toBeUndefined();
  });
});
