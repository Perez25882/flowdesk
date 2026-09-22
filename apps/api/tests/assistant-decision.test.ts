import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTRACT_VERSION, IntentType, type AssistantDecision } from '@flowdesk/shared';
import {
  ASSISTANT_DECISION_JSON_SCHEMA,
  applyServerInvariants,
  escalationRequired,
  parseDecision,
} from '../src/services/assistant/decision.js';
import { buildEvidenceSet } from '../src/services/assistant/evidence.js';

const evidence = buildEvidenceSet({
  products: [
    { id: 'p_rice5', name: 'Rice 5kg', unit: 'bag', price: 80, stockQuantity: 12 },
    { id: 'p_malta', name: 'Malta Guinness 33cl', unit: 'bottle', price: 12.5, stockQuantity: 0 },
  ],
  profile: { deliveryFee: 20 },
  openOrders: [
    {
      id: 'o_1',
      referenceNumber: 'FD-A1B2',
      status: 'PENDING',
      totalAmount: 160,
      amountPaid: 60,
    },
  ],
  mentionedQuantities: [2],
  businessPhones: ['0244000111'],
});

/** A well-formed decision, so each test can change exactly the one thing it is about. */
function goodDecision(overrides: Partial<AssistantDecision> = {}): AssistantDecision {
  return {
    version: ASSISTANT_CONTRACT_VERSION,
    intent: IntentType.INQUIRY,
    confidence: 0.9,
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

const rawDecision = {
  intent: 'INQUIRY',
  confidence: 0.9,
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
};

describe('ASSISTANT_DECISION_JSON_SCHEMA', () => {
  // Structured outputs reject a schema whose objects allow extra keys, and the
  // rejection arrives as a 400 at request time rather than at build time.
  it('closes every object it declares', () => {
    const closed: string[] = [];
    const open: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;

      if (record.type === 'object') {
        (record.additionalProperties === false ? closed : open).push(path);
      }

      for (const [key, value] of Object.entries(record)) {
        if (Array.isArray(value)) {
          value.forEach((item, i) => walk(item, `${path}.${key}[${i}]`));
        } else {
          walk(value, `${path}.${key}`);
        }
      }
    };

    walk(ASSISTANT_DECISION_JSON_SCHEMA, '$');

    expect(open).toEqual([]);
    expect(closed.length).toBeGreaterThan(4);
  });

  it('requires every property it declares, so no field arrives missing', () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;

      if (record.type === 'object' && record.properties) {
        const declared = Object.keys(record.properties as Record<string, unknown>).sort();
        const required = [...((record.required as string[] | undefined) ?? [])].sort();
        expect(required, `at ${path}`).toEqual(declared);
      }

      for (const [key, value] of Object.entries(record)) {
        if (Array.isArray(value)) {
          value.forEach((item, i) => walk(item, `${path}.${key}[${i}]`));
        } else {
          walk(value, `${path}.${key}`);
        }
      }
    };

    walk(ASSISTANT_DECISION_JSON_SCHEMA, '$');
  });

  it('does not use constraints structured outputs rejects', () => {
    const serialized = JSON.stringify(ASSISTANT_DECISION_JSON_SCHEMA);
    for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) {
      expect(serialized).not.toContain(`"${banned}"`);
    }
  });
});

describe('parseDecision', () => {
  it('accepts a well-formed decision and stamps the contract version', () => {
    const parsed = parseDecision(rawDecision);
    expect(parsed?.version).toBe(ASSISTANT_CONTRACT_VERSION);
    expect(parsed?.intent).toBe(IntentType.INQUIRY);
  });

  it('returns null rather than throwing on a shape it does not recognise', () => {
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision('ORDER')).toBeNull();
    expect(parseDecision({})).toBeNull();
    expect(parseDecision({ intent: 'NOT_A_REAL_INTENT' })).toBeNull();
  });

  it('fills in the empty fields open models leave out, inertly', () => {
    // A live probe lost a correct delivery answer because the model omitted two
    // empty arrays. Defaulting them is safe precisely because the defaults are
    // inert: nothing is grounded, so nothing is sendable.
    const parsed = parseDecision({ intent: 'ORDER' });

    expect(parsed).not.toBeNull();
    expect(parsed?.confidence).toBe(0);
    expect(parsed?.answer.canAnswer).toBe(false);
    expect(parsed?.answer.groundedOn).toEqual([]);
    expect(parsed?.entities.products).toEqual([]);
  });

  it('rejects UNCLASSIFIED — that is a server outcome, not something to choose', () => {
    expect(parseDecision({ ...rawDecision, intent: 'UNCLASSIFIED' })).toBeNull();
  });

  it('normalises absent optional fields to null rather than undefined', () => {
    const parsed = parseDecision({
      ...rawDecision,
      entities: {
        products: [{ productId: null, mention: 'rice', quantity: null }],
        orderReferences: [],
        deliveryArea: null,
      },
      answer: { ...rawDecision.answer, groundedOn: [{ kind: 'product', id: 'p_rice5' }] },
    });

    expect(parsed?.entities.deliveryArea).toBeNull();
    expect(parsed?.entities.products[0]?.productId).toBeNull();
    expect(parsed?.answer.groundedOn[0]).not.toHaveProperty('field');
  });
});

describe('applyServerInvariants', () => {
  it('drops a cited id the server never supplied', () => {
    const result = applyServerInvariants(
      goodDecision({
        answer: {
          canAnswer: true,
          text: 'Yam is GHS 40.',
          groundedOn: [{ kind: 'product', id: 'p_yam_invented', field: 'price' }],
        },
      }),
      evidence,
    );

    expect(result.answer.groundedOn).toEqual([]);
  });

  it('refuses to call an answer sendable once its only citation is dropped', () => {
    // This is the whole point of the pass: without it, a model that invents an
    // id hands itself the grounded flag the auto-send gate keys on.
    const result = applyServerInvariants(
      goodDecision({
        answer: {
          canAnswer: true,
          text: 'Yam is GHS 40.',
          groundedOn: [{ kind: 'product', id: 'p_yam_invented' }],
        },
      }),
      evidence,
    );

    expect(result.answer.canAnswer).toBe(false);
  });

  it('keeps citations that resolve to real rows', () => {
    const result = applyServerInvariants(goodDecision(), evidence);
    expect(result.answer.groundedOn).toHaveLength(1);
    expect(result.answer.canAnswer).toBe(true);
  });

  it('accepts a business fact that was actually rendered into the prompt', () => {
    const result = applyServerInvariants(
      goodDecision({
        answer: {
          canAnswer: true,
          text: 'Delivery is GHS 20.',
          groundedOn: [{ kind: 'business_fact', id: 'deliveryFee' }],
        },
      }),
      evidence,
    );

    expect(result.answer.canAnswer).toBe(true);
  });

  it('rejects a business fact key that was never rendered', () => {
    const result = applyServerInvariants(
      goodDecision({
        answer: {
          canAnswer: true,
          text: 'We open at 8.',
          groundedOn: [{ kind: 'business_fact', id: 'openingHours' }],
        },
      }),
      evidence,
    );

    expect(result.answer.canAnswer).toBe(false);
  });

  it('accepts an order cited by id or by reference', () => {
    for (const id of ['o_1', 'FD-A1B2', 'fd-a1b2']) {
      const result = applyServerInvariants(
        goodDecision({
          answer: {
            canAnswer: true,
            text: 'You still owe GHS 100 on that order.',
            groundedOn: [{ kind: 'order', id }],
          },
        }),
        evidence,
      );

      expect(result.answer.canAnswer, id).toBe(true);
    }
  });

  it('cannot answer and ask a question in the same breath', () => {
    const result = applyServerInvariants(
      goodDecision({ clarification: { needed: true, missing: ['quantity'] } }),
      evidence,
    );

    expect(result.answer.canAnswer).toBe(false);
  });

  it('will not mark an order complete while it is still asking about it', () => {
    const result = applyServerInvariants(
      goodDecision({
        order: { isOrder: true, complete: true },
        clarification: { needed: true, missing: ['quantity'] },
      }),
      evidence,
    );

    expect(result.order.complete).toBe(false);
  });

  it('discards a blank answer that claims to be answerable', () => {
    const result = applyServerInvariants(
      goodDecision({
        answer: { canAnswer: true, text: '   ', groundedOn: [{ kind: 'product', id: 'p_rice5' }] },
      }),
      evidence,
    );

    expect(result.answer.canAnswer).toBe(false);
    expect(result.answer.text).toBeNull();
  });

  it('discards a runaway answer', () => {
    const result = applyServerInvariants(
      goodDecision({
        answer: {
          canAnswer: true,
          text: 'x'.repeat(1_001),
          groundedOn: [{ kind: 'product', id: 'p_rice5' }],
        },
      }),
      evidence,
    );

    expect(result.answer.canAnswer).toBe(false);
  });

  it('clamps a confidence outside the range the contract promises', () => {
    expect(applyServerInvariants(goodDecision({ confidence: 4.2 }), evidence).confidence).toBe(1);
    expect(applyServerInvariants(goodDecision({ confidence: -1 }), evidence).confidence).toBe(0);
  });

  it('nulls an invented product id but keeps the words the customer used', () => {
    // The mention is what the clarification question is built from, so losing it
    // would turn "we don't stock plantain" into silence.
    const result = applyServerInvariants(
      goodDecision({
        entities: {
          products: [{ productId: 'p_nope', mention: 'plantain', quantity: 3 }],
          orderReferences: [],
          deliveryArea: null,
        },
      }),
      evidence,
    );

    expect(result.entities.products[0]).toEqual({
      productId: null,
      mention: 'plantain',
      quantity: 3,
    });
  });

  it('drops an order reference belonging to someone else', () => {
    const result = applyServerInvariants(
      goodDecision({
        entities: { products: [], orderReferences: ['FD-ZZZZ'], deliveryArea: null },
      }),
      evidence,
    );

    expect(result.entities.orderReferences).toEqual([]);
  });

  it('rounds a fractional quantity and drops a nonsensical one', () => {
    const result = applyServerInvariants(
      goodDecision({
        entities: {
          products: [
            { productId: 'p_rice5', mention: 'rice', quantity: 2.4 },
            { productId: 'p_malta', mention: 'malta', quantity: -1 },
          ],
          orderReferences: [],
          deliveryArea: null,
        },
      }),
      evidence,
    );

    expect(result.entities.products[0]?.quantity).toBe(2);
    expect(result.entities.products[1]?.quantity).toBeNull();
  });

  it('deduplicates repeated citations', () => {
    const result = applyServerInvariants(
      goodDecision({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 80.',
          groundedOn: [
            { kind: 'product', id: 'p_rice5', field: 'price' },
            { kind: 'product', id: 'p_rice5', field: 'price' },
          ],
        },
      }),
      evidence,
    );

    expect(result.answer.groundedOn).toHaveLength(1);
  });

  it('caps the arrays the model controls', () => {
    const result = applyServerInvariants(
      goodDecision({
        entities: {
          products: Array.from({ length: 50 }, (_, i) => ({
            productId: 'p_rice5',
            mention: `thing ${i}`,
            quantity: 1,
          })),
          orderReferences: [],
          deliveryArea: null,
        },
      }),
      evidence,
    );

    expect(result.entities.products.length).toBeLessThanOrEqual(10);
  });

  it('leaves escalation exactly as the model set it — merging is the caller’s job', () => {
    const result = applyServerInvariants(
      goodDecision({ escalate: { needed: true, reason: 'complaint' } }),
      evidence,
    );

    expect(result.escalate).toEqual({ needed: true, reason: 'complaint' });
  });
});

describe('escalationRequired', () => {
  it('honours the model asking for a person', () => {
    expect(
      escalationRequired(goodDecision({ escalate: { needed: true, reason: 'bargaining' } }), false),
    ).toBe(true);
  });

  it('does not let the model clear a server-side escalation', () => {
    expect(escalationRequired(goodDecision(), true)).toBe(true);
  });

  it('does not escalate merely because there is no decision', () => {
    // A shop with no API key would otherwise have every greeting flagged. What
    // actually needs a person when the assistant is silent is decided by
    // `requiresReview`'s fallback branch.
    expect(escalationRequired(null, false)).toBe(false);
  });

  it('still escalates a missing decision when the server said so', () => {
    expect(escalationRequired(null, true)).toBe(true);
  });

  it('stays quiet when neither side asked for one', () => {
    expect(escalationRequired(goodDecision(), false)).toBe(false);
  });
});
