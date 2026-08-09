import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTRACT_VERSION, IntentType, type AssistantDecision } from '@flowdesk/shared';
import { requiresReview, routeDecision, type RouteInput } from '../src/services/assistant/router.js';
import { buildEvidenceSet, type EvidenceProduct } from '../src/services/assistant/evidence.js';

const products: EvidenceProduct[] = [
  { id: 'p_rice5', name: 'Rice 5kg', unit: 'bag', price: 80, stockQuantity: 12 },
  { id: 'p_rice25', name: 'Rice 25kg', unit: 'bag', price: 350, stockQuantity: 4 },
  { id: 'p_malta', name: 'Malta Guinness 33cl', unit: 'bottle', price: 12.5, stockQuantity: 0 },
];

const evidence = buildEvidenceSet({
  products,
  profile: { deliveryFee: 20, deliveryAreas: ['Tema', 'Spintex'] },
  openOrders: [],
  mentionedQuantities: [2],
  businessPhones: ['0244000111'],
});

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
      text: 'Rice 5kg is GHS 80 per bag.',
      groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
    },
    clarification: { needed: false, missing: [] },
    order: { isOrder: false, complete: false },
    escalate: { needed: false, reason: null },
    ...overrides,
  };
}

function routeFor(overrides: Partial<RouteInput> = {}) {
  return routeDecision({
    mode: 'GROUNDED_AUTO',
    decision: decisionFor(),
    evidence,
    products,
    profile: { deliveryFee: 20, deliveryAreas: ['Tema', 'Spintex'] },
    serverEscalation: false,
    clarificationCount: 0,
    canDeliver: true,
    ...overrides,
  });
}

describe('routeDecision — the auto-send slice', () => {
  it('sends a grounded, confident, single-product price answer', () => {
    const result = routeFor();
    expect(result.action).toBe('auto_send');
    expect(result.text).toBe('Rice 5kg is GHS 80 per bag.');
    expect(result.validationFailures).toEqual([]);
  });

  it('sends an answer resting only on a business fact', () => {
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Delivery to Tema is GHS 20.',
          groundedOn: [{ kind: 'business_fact', id: 'deliveryFee' }],
        },
      }),
    });

    expect(result.action).toBe('auto_send');
  });

  it('records what the answer rested on in a form the message row can store', () => {
    expect(routeFor().groundedOn).toEqual(['product:p_rice5:price']);
  });
});

describe('routeDecision — everything that blocks auto-send', () => {
  it('drafts when the tenant has not switched auto-send on', () => {
    expect(routeFor({ mode: 'DRAFT_ONLY' }).action).toBe('draft');
  });

  it('writes nothing at all when the assistant is off', () => {
    const result = routeFor({ mode: 'OFF' });
    expect(result.action).toBe('template_reply');
    expect(result.text).toBeNull();
  });

  it('drafts a price the evidence set does not carry', () => {
    // The number is plausible, the product is real, and it is still wrong.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 75 per bag.',
          groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
        },
      }),
    });

    expect(result.action).toBe('draft');
    expect(result.validationFailures).toContain('unverified_amount');
  });

  it('drafts an answer that affirms availability of something out of stock', () => {
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Yes we have Malta Guinness, GHS 12.50 a bottle.',
          groundedOn: [{ kind: 'product', id: 'p_malta', field: 'price' }],
        },
      }),
    });

    expect(result.action).toBe('draft');
    expect(result.validationFailures).toContain('availability_contradicts_stock');
  });

  it('drafts anything carrying a link or a foreign number', () => {
    const withLink = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 80. Pay at https://pay.example.com',
          groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
        },
      }),
    });

    expect(withLink.action).toBe('draft');
    expect(withLink.validationFailures).toContain('contains_url');

    const withPhone = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 80. Send money to 0201234567.',
          groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
        },
      }),
    });

    expect(withPhone.validationFailures).toContain('foreign_phone_number');
  });

  it('drafts an answer that cites more than one product', () => {
    // "Rice is GHS 80" is wrong at a shop selling two sizes of rice, even
    // though 80 is a real price.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice is GHS 80.',
          groundedOn: [
            { kind: 'product', id: 'p_rice5', field: 'price' },
            { kind: 'product', id: 'p_rice25', field: 'price' },
          ],
        },
      }),
    });

    expect(result.action).toBe('draft');
  });

  it('drafts a low-confidence answer even when every figure checks out', () => {
    expect(routeFor({ decision: decisionFor({ confidence: 0.5 }) }).action).toBe('draft');
  });

  it('never auto-sends an order, even a fully settled one', () => {
    // A commitment is not a question. It goes through order creation where the
    // owner can see it, never out as a chat reply nobody reviewed.
    const result = routeFor({
      decision: decisionFor({
        order: { isOrder: true, complete: true },
        entities: {
          products: [{ productId: 'p_rice5', mention: 'Rice 5kg', quantity: 2 }],
          orderReferences: [],
          deliveryArea: null,
        },
      }),
    });

    expect(result.action).toBe('draft');
  });

  it('asks rather than drafts when an order names no product it can price', () => {
    // The server derives this: the model reported nothing missing, but with two
    // sizes retrieved and none chosen there is no order to create.
    expect(
      routeFor({ decision: decisionFor({ order: { isOrder: true, complete: true } }) }).action,
    ).toBe('clarify');
  });

  it('drafts intents outside the sendable slice', () => {
    for (const intent of [IntentType.PAYMENT, IntentType.COMPLAINT]) {
      expect(routeFor({ decision: decisionFor({ intent }) }).action, intent).toBe('draft');
    }
  });

  it('drafts when the model asked for a person', () => {
    expect(
      routeFor({
        decision: decisionFor({ escalate: { needed: true, reason: 'bargaining' } }),
      }).action,
    ).toBe('draft');
  });

  it('drafts when the server escalated, whatever the model said', () => {
    const result = routeFor({ serverEscalation: true });
    expect(result.action).toBe('draft');
    expect(result.escalated).toBe(true);
  });

  it('drafts rather than sending once the 24-hour window has closed', () => {
    // Meta would reject it, the job would dead-letter, and the owner would never
    // learn the customer went unanswered.
    expect(routeFor({ canDeliver: false }).action).toBe('draft');
  });
});

describe('routeDecision — clarification', () => {
  const needsQuantity = decisionFor({
    intent: IntentType.ORDER,
    answer: { canAnswer: false, text: null, groundedOn: [] },
    clarification: { needed: true, missing: ['quantity'] },
    order: { isOrder: true, complete: false },
  });

  it('asks a question composed from real catalogue rows', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products: [products[0]!],
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
    });

    expect(result.action).toBe('clarify');
    expect(result.text).toBe('How many Rice 5kg would you like?');
  });

  it('asks even when auto-send is off — the question is ours, not the model’s', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
    });

    expect(result.action).toBe('clarify');
  });

  it('asks which one before how many when the message could mean either', () => {
    // The model reported only `quantity` missing, against a variant nobody
    // chose — live it produced "how many Rice 25kg?" for a bare "I want rice".
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: decisionFor({
        intent: IntentType.ORDER,
        entities: {
          products: [{ productId: 'p_rice25', mention: 'rice', quantity: null }],
          orderReferences: [],
          deliveryArea: null,
        },
        clarification: { needed: true, missing: ['quantity'] },
        order: { isOrder: true, complete: false },
      }),
      evidence,
      products: [products[0]!, products[1]!],
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
    });

    expect(result.action).toBe('clarify');
    expect(result.text).toContain('which one would you like?');
    expect(result.text).not.toContain('How many');
  });

  it('asks how many once only one product is in play', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: decisionFor({
        intent: IntentType.ORDER,
        entities: {
          products: [{ productId: 'p_rice5', mention: 'rice 5kg', quantity: null }],
          orderReferences: [],
          deliveryArea: null,
        },
        clarification: { needed: true, missing: ['quantity'] },
        order: { isOrder: true, complete: false },
      }),
      evidence,
      products: [products[0]!],
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
    });

    expect(result.text).toBe('How many Rice 5kg would you like?');
  });

  it('stops asking after the cap and hands over', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: false,
      clarificationCount: 2,
      canDeliver: true,
    });

    expect(result.action).not.toBe('clarify');
  });

  it('does not ask a question it cannot send', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: false,
    });

    expect(result.action).not.toBe('clarify');
  });

  it('escalates instead of asking when a person is needed', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: true,
      clarificationCount: 0,
      canDeliver: true,
    });

    expect(result.action).not.toBe('clarify');
    expect(result.escalated).toBe(true);
  });
});

describe('routeDecision — when the assistant did not run', () => {
  it('falls back to the template so the customer is not ignored', () => {
    const result = routeFor({ decision: null });
    expect(result.action).toBe('template_reply');
  });

  it('does not flag every message just because the assistant is silent', () => {
    // Regression: an unconfigured shop had every greeting escalated, which is
    // the queue-flooding this rework exists to stop.
    expect(routeFor({ decision: null }).escalated).toBe(false);
    expect(requiresReview(IntentType.GREETING, 0.8, 'template_reply', false)).toBe(false);
  });

  it('still routes the messages a person always had to answer', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.9, 'template_reply', false)).toBe(true);
  });
});

describe('requiresReview', () => {
  it('leaves an auto-sent answer out of the queue', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.95, 'auto_send', false)).toBe(false);
  });

  it('leaves a clarification out of the queue — it is being handled', () => {
    expect(requiresReview(IntentType.ORDER, 0.9, 'clarify', false)).toBe(false);
  });

  it('queues a draft, which is waiting on the owner by definition', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.95, 'draft', false)).toBe(true);
  });

  it('queues anything escalated regardless of how it was handled', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.95, 'auto_send', true)).toBe(true);
  });

  it('keeps the old intent rule when the assistant did not run', () => {
    // Without a reply written, these are exactly the messages an owner has
    // always had to answer themselves.
    expect(requiresReview(IntentType.INQUIRY, 0.9, 'template_reply', false)).toBe(true);
    expect(requiresReview(IntentType.COMPLAINT, 0.9, 'template_reply', false)).toBe(true);
    expect(requiresReview(IntentType.PAYMENT, 0.9, 'template_reply', false)).toBe(true);
    expect(requiresReview(IntentType.GREETING, 0.9, 'template_reply', false)).toBe(false);
  });

  it('queues an unclassified or low-confidence message however it was routed', () => {
    expect(requiresReview(IntentType.UNCLASSIFIED, 0.9, 'auto_send', false)).toBe(true);
    expect(requiresReview(IntentType.INQUIRY, 0.4, 'auto_send', false)).toBe(true);
  });
});
