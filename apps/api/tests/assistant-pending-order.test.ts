import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTRACT_VERSION, IntentType, type AssistantDecision } from '@flowdesk/shared';
import { resolveOrderItems } from '../src/services/assistant/index.js';
import { expiresAtFrom } from '../src/services/assistant/pending-order.js';
import type { EvidenceProduct } from '../src/services/assistant/evidence.js';

const products: EvidenceProduct[] = [
  { id: 'p_rice5', name: 'Rice 5kg', unit: 'bag', price: 80, stockQuantity: 12 },
  { id: 'p_coke', name: 'Coca-Cola 50cl', unit: 'bottle', price: 8, stockQuantity: 60 },
];

function decisionWith(
  mentions: AssistantDecision['entities']['products'],
): AssistantDecision {
  return {
    version: ASSISTANT_CONTRACT_VERSION,
    intent: IntentType.ORDER,
    confidence: 0.95,
    language: 'gh_en',
    sentiment: 'neutral',
    entities: { products: mentions, orderReferences: [], deliveryArea: null },
    answer: { canAnswer: false, text: null, groundedOn: [] },
    clarification: { needed: false, missing: [] },
    order: { isOrder: true, complete: true },
    escalate: { needed: false, reason: null },
  };
}

describe('resolveOrderItems', () => {
  it('prices a line from the catalogue row, not from the model', () => {
    // The whole reason this exists: a model-supplied price would be an
    // unverified figure written straight onto an invoice.
    const items = resolveOrderItems(
      decisionWith([{ productId: 'p_rice5', mention: 'rice', quantity: 2 }]),
      { products },
    );

    expect(items).toEqual([
      { productId: 'p_rice5', description: 'Rice 5kg', quantity: 2, unitPrice: 80 },
    ]);
  });

  it('drops a mention that resolves to no catalogue row', () => {
    const items = resolveOrderItems(
      decisionWith([
        { productId: 'p_rice5', mention: 'rice', quantity: 1 },
        { productId: 'p_invented', mention: 'plantain', quantity: 3 },
      ]),
      { products },
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.productId).toBe('p_rice5');
  });

  it('drops an unresolved mention entirely rather than pricing it at zero', () => {
    const items = resolveOrderItems(
      decisionWith([{ productId: null, mention: 'something', quantity: 1 }]),
      { products },
    );

    // Empty means the caller declines to create the order, which is the point:
    // a zero-priced line is a real order the owner has to notice and fix.
    expect(items).toEqual([]);
  });

  it('defaults a missing quantity to one rather than to nothing', () => {
    const items = resolveOrderItems(
      decisionWith([{ productId: 'p_coke', mention: 'coke', quantity: null }]),
      { products },
    );

    expect(items[0]?.quantity).toBe(1);
  });

  it('builds a multi-line order', () => {
    const items = resolveOrderItems(
      decisionWith([
        { productId: 'p_rice5', mention: 'rice', quantity: 2 },
        { productId: 'p_coke', mention: 'coke', quantity: 6 },
      ]),
      { products },
    );

    expect(items).toHaveLength(2);
    expect(items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0)).toBe(2 * 80 + 6 * 8);
  });
});

describe('pending order expiry', () => {
  it('gives a conversation 48 hours to come back', () => {
    const now = new Date('2026-08-09T12:00:00Z');
    expect(expiresAtFrom(now).toISOString()).toBe('2026-08-11T12:00:00.000Z');
  });

  it('is always in the future relative to the moment it was set', () => {
    const now = new Date();
    expect(expiresAtFrom(now).getTime()).toBeGreaterThan(now.getTime());
  });
});
