import { describe, expect, it } from 'vitest';
import { IntentType } from '@flowdesk/shared';
import { classifyIntent } from '../src/services/intent/rule-engine.js';

/**
 * Catalog-aware intent classification.
 *
 * Ghanaian SME customers routinely order without an ordering verb — "5 malta",
 * "2 bags rice" — which scored zero against verb-based rules and landed in the
 * review queue. Knowing the business's own product names turns those into
 * confident orders, and is what lifts accuracy toward the PRD's 90% target.
 *
 * The catalog must not override clear signals of some other intent: "I paid for
 * the malta" is a payment notice, not a new order.
 */
const catalog = ['Rice 50kg', 'rice', 'Malta Guinness 33cl', 'malta', 'Voltic Water 750ml', 'water'];

describe('classifyIntent with a catalog', () => {
  it('treats a bare quantity plus a known product as an order', () => {
    const result = classifyIntent('5 malta please', catalog);

    expect(result.intent).toBe(IntentType.ORDER);
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('classifies a product name with no verb at all', () => {
    expect(classifyIntent('2 bags rice', catalog).intent).toBe(IntentType.ORDER);
    expect(classifyIntent('10 water', catalog).intent).toBe(IntentType.ORDER);
  });

  it('still classifies verb-led orders without needing the catalog', () => {
    const result = classifyIntent('I want 3 bags of rice');

    expect(result.intent).toBe(IntentType.ORDER);
  });

  it('does not turn a payment notice into an order just because a product is named', () => {
    // The customer is telling us about money, not asking for goods.
    for (const message of [
      'I have paid for the malta',
      'i just paid 500 for the rice',
      'payment done for 5 malta',
    ]) {
      expect(classifyIntent(message, catalog).intent, message).not.toBe(IntentType.ORDER);
    }
  });

  it('does not turn a complaint into an order', () => {
    const result = classifyIntent('the malta you sent is expired, this is unacceptable', catalog);

    expect(result.intent).not.toBe(IntentType.ORDER);
  });

  it('does not turn a price question into an order', () => {
    const result = classifyIntent('how much is malta?', catalog);

    expect(result.intent).not.toBe(IntentType.ORDER);
  });

  it('ignores a product mentioned with no quantity or intent', () => {
    // "do you have malta" is availability, not a commitment to buy.
    const result = classifyIntent('do you have malta?', catalog);

    expect(result.intent).not.toBe(IntentType.ORDER);
  });

  it('behaves exactly as before when no catalog is supplied', () => {
    const withoutCatalog = classifyIntent('5 malta please');
    const emptyCatalog = classifyIntent('5 malta please', []);

    expect(withoutCatalog).toEqual(emptyCatalog);
  });

  it('matches product names case-insensitively', () => {
    expect(classifyIntent('3 MALTA', catalog).intent).toBe(IntentType.ORDER);
    expect(classifyIntent('3 Malta Guinness 33cl', catalog).intent).toBe(IntentType.ORDER);
  });

  it('does not match a product name inside an unrelated word', () => {
    // "waterfall" must not count as the product "water".
    const result = classifyIntent('the waterfall was nice', catalog);

    expect(result.intent).not.toBe(IntentType.ORDER);
  });
});
