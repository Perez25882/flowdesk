import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTRACT_VERSION, IntentType, type AssistantDecision } from '@flowdesk/shared';
import { priceOfferStatus, routeDecision, type RouteInput } from '../src/services/assistant/router.js';
import { buildEvidenceSet, type EvidenceProduct } from '../src/services/assistant/evidence.js';
import { buildLadder } from '../src/services/pricing/ladder.js';

/**
 * The floor, proved at the only place that matters: the gate that decides
 * whether words reach a customer.
 *
 * `price-ladder.test.ts` proves the arithmetic. This proves that the arithmetic
 * is actually consulted, in every mode, including the one where the owner has
 * switched off every other check.
 */

function negotiableProducts(): EvidenceProduct[] {
  return [
    {
      id: 'p_jeans',
      name: 'Baggy jeans',
      unit: 'pair',
      price: 120,
      stockQuantity: 8,
      ladder: buildLadder({ price: 120, floorPrice: 95, bargainingEnabled: true }),
    },
    {
      id: 'p_tee',
      name: 'Plain tee',
      unit: 'piece',
      price: 40,
      stockQuantity: 20,
      // No floor: this one is not negotiable even though the shop allows it.
      ladder: buildLadder({ price: 40, bargainingEnabled: true }),
    },
  ];
}

function decisionFor(overrides: Partial<AssistantDecision> = {}): AssistantDecision {
  return {
    version: ASSISTANT_CONTRACT_VERSION,
    intent: IntentType.INQUIRY,
    confidence: 0.95,
    language: 'gh_en',
    sentiment: 'neutral',
    entities: { products: [], orderReferences: [], deliveryArea: null },
    answer: {
      canAnswer: true,
      text: 'I can do GHS 100 for the baggy jeans.',
      groundedOn: [{ kind: 'product', id: 'p_jeans', field: 'price' }],
    },
    clarification: { needed: false, missing: [] },
    order: { isOrder: false, complete: false },
    escalate: { needed: false, reason: null },
    priceOffer: null,
    ...overrides,
  };
}

function routeFor(overrides: Partial<RouteInput> = {}) {
  const products = negotiableProducts();
  const evidence = buildEvidenceSet({
    products,
    profile: null,
    openOrders: [],
    mentionedQuantities: [],
    businessPhones: ['0244000111'],
  });

  return routeDecision({
    mode: 'AUTONOMOUS',
    catalogueMode: 'CATALOGUE',
    decision: decisionFor(),
    evidence,
    products,
    profile: null,
    serverEscalation: false,
    clarificationCount: 0,
    canDeliver: true,
    message: 'last price for the baggy jeans?',
    ...overrides,
  } as RouteInput);
}

describe('priceOfferStatus', () => {
  const products = negotiableProducts();

  it('is "none" when the reply offers no discount', () => {
    expect(priceOfferStatus(decisionFor(), products)).toBe('none');
  });

  it('authorises an offer at or above the floor', () => {
    for (const unitPrice of [95, 100, 119.99, 120]) {
      const decision = decisionFor({ priceOffer: { productId: 'p_jeans', unitPrice, quantity: 1 } });
      expect(priceOfferStatus(decision, products)).toBe('authorised');
    }
  });

  it('refuses a single pesewa below the floor', () => {
    const decision = decisionFor({
      priceOffer: { productId: 'p_jeans', unitPrice: 94.99, quantity: 1 },
    });
    expect(priceOfferStatus(decision, products)).toBe('refused');
  });

  it('refuses any discount on a product with no floor', () => {
    const decision = decisionFor({
      priceOffer: { productId: 'p_tee', unitPrice: 39, quantity: 1 },
    });
    expect(priceOfferStatus(decision, products)).toBe('refused');
  });

  it('refuses a price for a product that was never shown to the model', () => {
    // An invented id is the shape of a model pricing something it made up.
    const decision = decisionFor({
      priceOffer: { productId: 'p_does_not_exist', unitPrice: 1, quantity: 1 },
    });
    expect(priceOfferStatus(decision, products)).toBe('refused');
  });

  it('refuses a nonsense price outright', () => {
    for (const unitPrice of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = decisionFor({
        priceOffer: { productId: 'p_jeans', unitPrice, quantity: 1 },
      });
      expect(priceOfferStatus(decision, products)).toBe('refused');
    }
  });
});

describe('the floor holds in every mode', () => {
  it('sends an offer that sits on the floor', () => {
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Best I can do is GHS 95 for the baggy jeans.',
          groundedOn: [{ kind: 'product', id: 'p_jeans', field: 'price' }],
        },
        priceOffer: { productId: 'p_jeans', unitPrice: 95, quantity: 1 },
      }),
    });

    expect(result.action).toBe('auto_send');
  });

  it('refuses to send an offer below the floor even in AUTONOMOUS mode', () => {
    // The whole point. Autonomous mode waives the evidence gate; it does not
    // waive the shop's margin.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Alright, GHS 90 and it is yours.',
          groundedOn: [{ kind: 'product', id: 'p_jeans', field: 'price' }],
        },
        priceOffer: { productId: 'p_jeans', unitPrice: 90, quantity: 1 },
      }),
    });

    expect(result.action).not.toBe('auto_send');
  });

  it('refuses in GROUNDED_AUTO too', () => {
    const result = routeFor({
      mode: 'GROUNDED_AUTO',
      decision: decisionFor({
        priceOffer: { productId: 'p_jeans', unitPrice: 90, quantity: 1 },
      }),
    });

    expect(result.action).not.toBe('auto_send');
  });
});

describe('negotiation re-arms the money check that autonomy waives', () => {
  it('holds a cedi figure nobody authorised while haggling is possible', () => {
    // GHS 103 is not the list price, not the floor, and not a rung between
    // them. In an ordinary autonomous reply this would go out with the failure
    // logged. With a floor set it must not, because the shop can be held to it.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'I can let the baggy jeans go for GHS 103.',
          groundedOn: [{ kind: 'product', id: 'p_jeans', field: 'price' }],
        },
      }),
    });

    expect(result.action).not.toBe('auto_send');
    expect(result.validationFailures).toContain('unverified_amount');
  });

  it('still sends a non-money claim nobody could verify, because autonomy does cover that', () => {
    // No figure at all. Autonomy's grant is untouched by the narrowing above.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'We open at eight in the morning.',
          groundedOn: [],
        },
      }),
    });

    expect(result.action).toBe('auto_send');
  });
});

describe('a settled haggle no longer needs the owner', () => {
  it('sends when the model escalated for bargaining but made a legal offer', () => {
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'I can do GHS 95 for the baggy jeans, that is my best.',
          groundedOn: [{ kind: 'product', id: 'p_jeans', field: 'price' }],
        },
        escalate: { needed: true, reason: 'bargaining' },
        priceOffer: { productId: 'p_jeans', unitPrice: 95, quantity: 1 },
      }),
    });

    expect(result.action).toBe('auto_send');
  });

  it('does not send when the bargaining escalation came with no declared offer', () => {
    const result = routeFor({
      decision: decisionFor({
        escalate: { needed: true, reason: 'bargaining' },
      }),
    });

    expect(result.action).not.toBe('auto_send');
  });

  it('never clears an escalation the server itself raised', () => {
    const result = routeFor({
      serverEscalation: true,
      decision: decisionFor({
        escalate: { needed: true, reason: 'bargaining' },
        priceOffer: { productId: 'p_jeans', unitPrice: 95, quantity: 1 },
      }),
    });

    expect(result.action).not.toBe('auto_send');
  });

  it('leaves a complaint escalation alone, offer or no offer', () => {
    const result = routeFor({
      decision: decisionFor({
        escalate: { needed: true, reason: 'complaint' },
        priceOffer: { productId: 'p_jeans', unitPrice: 95, quantity: 1 },
      }),
    });

    expect(result.action).not.toBe('auto_send');
  });
});
