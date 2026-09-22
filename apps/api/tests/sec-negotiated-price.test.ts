import { describe, expect, it } from 'vitest';
import { resolveOrderItems } from '../src/services/assistant/index.js';
import type { AssistantDecision } from '../src/services/assistant/decision.js';

/**
 * What the customer was promised is what the customer is charged.
 *
 * The bargaining floor is a genuine server-side clamp: `offerIsAuthorised`
 * checks the model's declared price against a ladder the server computed, and
 * refuses rather than clamping. But that verdict only ever gated whether the
 * REPLY could be auto-sent. Order creation hard-coded `unitPrice: product.price`
 * and never read the offer at all.
 *
 * So a shop that had set a floor — the owner saying in advance "anything down
 * to forty, decide it yourself" — would have its assistant write "okay, GHS 40"
 * and then raise an order at the GHS 50 list price. The shop's margin was never
 * at risk; its word was. That is a chargeback and a reputation problem in a
 * market that runs on trust, and it is the kind of defect that looks like
 * correct behaviour until a customer compares the message to the invoice.
 *
 * Only an AUTHORISED offer may price an order. One below the floor is refused
 * upstream and must never arrive here.
 */

const PRODUCTS = [
  { id: 'p1', name: 'Rice 5kg', price: 50, unit: 'bag' },
  { id: 'p2', name: 'Oil 1L', price: 30, unit: 'bottle' },
];

function decisionOrdering(mentions: { productId: string; quantity: number }[]): AssistantDecision {
  return { entities: { products: mentions } } as unknown as AssistantDecision;
}

const context = { products: PRODUCTS } as never;

describe('resolveOrderItems', () => {
  it('bills the list price when nothing was negotiated', () => {
    const items = resolveOrderItems(decisionOrdering([{ productId: 'p1', quantity: 2 }]), context, null);

    expect(items).toEqual([{ productId: 'p1', description: 'Rice 5kg', quantity: 2, unitPrice: 50 }]);
  });

  it('bills the agreed price when the shop authorised the offer', () => {
    const items = resolveOrderItems(decisionOrdering([{ productId: 'p1', quantity: 2 }]), context, {
      productId: 'p1',
      unitPrice: 42,
      quantity: 2,
    });

    expect(items[0]!.unitPrice).toBe(42);
  });

  it('prices only the product the offer names', () => {
    // A discount agreed on rice must not silently apply to the oil in the same
    // basket.
    const items = resolveOrderItems(
      decisionOrdering([
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 1 },
      ]),
      context,
      { productId: 'p1', unitPrice: 42, quantity: 1 },
    );

    expect(items.find((i) => i.productId === 'p1')!.unitPrice).toBe(42);
    expect(items.find((i) => i.productId === 'p2')!.unitPrice).toBe(30);
  });

  it('ignores an offer for a product that is not in the order', () => {
    const items = resolveOrderItems(decisionOrdering([{ productId: 'p1', quantity: 1 }]), context, {
      productId: 'p2',
      unitPrice: 5,
      quantity: 1,
    });

    expect(items[0]!.unitPrice).toBe(50);
  });

  it('refuses an offer of zero or less and falls back to the shelf price', () => {
    // Defence in depth. `offerIsAuthorised` already rejects these upstream, but
    // this function is what actually decides what the customer is charged, so
    // it does not take a free item on trust from anywhere.
    for (const unitPrice of [0, -5]) {
      const items = resolveOrderItems(decisionOrdering([{ productId: 'p1', quantity: 1 }]), context, {
        productId: 'p1',
        unitPrice,
        quantity: 1,
      });

      expect(items[0]!.unitPrice).toBe(50);
    }
  });
});
