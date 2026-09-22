import { describe, expect, it } from 'vitest';
import {
  allowedFigures,
  composeFallbackInsight,
  figuresIn,
  verifyInsightNarrative,
} from '../src/services/insights/compose.js';
import { hasSomethingToSay, type DayFacts } from '../src/services/insights/collect.js';

/**
 * The morning summary's arithmetic.
 *
 * A wrong price reaches one customer. A wrong revenue figure in a summary is
 * what an owner makes next week's buying decision on, and they will believe it
 * because it came from their own system about their own shop. So the model
 * writes the sentences and every number is checked against the facts.
 */
function facts(overrides: Partial<DayFacts> = {}): DayFacts {
  return {
    date: '2026-09-16',
    messagesIn: 42,
    messagesOut: 38,
    customersWhoWrote: 17,
    newCustomers: 4,
    ordersCreated: 9,
    ordersValue: 1840,
    ordersFulfilled: 6,
    ordersCancelled: 1,
    revenue: 1250,
    paymentLinksOpen: 3,
    paymentLinksOpenValue: 590,
    awaitingOwner: 2,
    unverifiedRepliesSent: 0,
    lowStockCount: 2,
    lowStockNames: ['Rice 5kg', 'Coca-Cola 33cl'],
    topProducts: [{ name: 'Rice 5kg', quantity: 12, value: 960 }],
    previous: { messagesIn: 30, ordersCreated: 5, revenue: 900 },
    ...overrides,
  };
}

describe('figuresIn', () => {
  it('reads a figure with thousands separators as one number', () => {
    expect(figuresIn('You took GHS 1250.00 yesterday')).toEqual([1250]);
  });

  it('finds every number in a sentence', () => {
    expect(figuresIn('9 orders, 42 messages')).toEqual([9, 42]);
  });
});

describe('verifyInsightNarrative', () => {
  it('accepts a summary built only from the facts', () => {
    const text = 'You took GHS 1250.00 yesterday from 9 orders.\n42 messages came in from 17 customers.';
    expect(verifyInsightNarrative(text, facts())).toBe(true);
  });

  it('accepts a difference against the day before', () => {
    // 1250 - 900. A real thing to say, and it appears in no raw field.
    const text = 'GHS 1250.00 in, GHS 350.00 more than the day before.';
    expect(verifyInsightNarrative(text, facts())).toBe(true);
  });

  it('accepts a percentage it could actually have computed', () => {
    // revenue / previous.revenue = 139%
    expect(verifyInsightNarrative('Takings were 139% of the day before.', facts())).toBe(true);
  });

  it('rejects a revenue figure nobody supplied', () => {
    // This is the whole point. GHS 1,450 is plausible, adjacent to real
    // figures, and completely invented.
    expect(verifyInsightNarrative('You took GHS 1,450.00 yesterday.', facts())).toBe(false);
  });

  it('rejects an invented average', () => {
    // 1250 / 9 = 138.89, which the model was told not to compute.
    expect(verifyInsightNarrative('That is about GHS 138.89 per order.', facts())).toBe(false);
  });

  it('ignores a date, which is not a claim about the business', () => {
    expect(verifyInsightNarrative('On 16 Sep 2026 you took GHS 1250.00.', facts())).toBe(true);
    expect(verifyInsightNarrative('2026-09-16: GHS 1250.00 in.', facts())).toBe(true);
  });

  it('ignores a time of day', () => {
    expect(verifyInsightNarrative('Quiet until 14:30, then 9 orders.', facts())).toBe(true);
  });

  it('allows small counting numbers that mean nothing on their own', () => {
    expect(verifyInsightNarrative('Two things worth doing today.', facts())).toBe(true);
    expect(verifyInsightNarrative('3 payment links are still open.', facts())).toBe(true);
  });
});

describe('allowedFigures', () => {
  it('includes the raw facts', () => {
    const allowed = allowedFigures(facts());
    expect(allowed.has(1250)).toBe(true);
    expect(allowed.has(42)).toBe(true);
    expect(allowed.has(960)).toBe(true);
  });

  it('does not include something merely close to a fact', () => {
    const allowed = allowedFigures(facts());
    expect(allowed.has(1251)).toBe(false);
    expect(allowed.has(1240)).toBe(false);
  });
});

describe('composeFallbackInsight', () => {
  it('states the takings and never invents anything', () => {
    const written = composeFallbackInsight(facts());
    expect(written.headline).toContain('GHS 1250.00');
    // The fallback is what gets stored when the model misbehaves, so it has to
    // pass the same check the model's version is held to.
    expect(verifyInsightNarrative(`${written.headline}\n${written.body}`, facts())).toBe(true);
  });

  it('says so plainly when nothing sold', () => {
    const quiet = facts({ revenue: 0, ordersCreated: 0, ordersValue: 0, topProducts: [], awaitingOwner: 0 });
    const written = composeFallbackInsight(quiet);
    expect(written.headline).toContain('quiet');
    expect(verifyInsightNarrative(`${written.headline}\n${written.body}`, quiet)).toBe(true);
  });

  it('gets its plurals right, because a summary reading "1 orders" looks broken', () => {
    const one = facts({ ordersCreated: 1, customersWhoWrote: 1, messagesIn: 1, paymentLinksOpen: 1 });
    const written = composeFallbackInsight(one);
    expect(written.body).toContain('1 order worth');
    expect(written.body).toContain('1 message from 1 customer');
    expect(written.body).not.toContain('1 orders');
  });
});

describe('hasSomethingToSay', () => {
  it('stays quiet on a day where genuinely nothing happened', () => {
    // A summary that says "nothing happened" every morning for a fortnight is
    // a notification people mute, and once muted it is gone for the morning
    // that mattered.
    expect(
      hasSomethingToSay(
        facts({
          messagesIn: 0,
          ordersCreated: 0,
          revenue: 0,
          awaitingOwner: 0,
          lowStockCount: 0,
        }),
      ),
    ).toBe(false);
  });

  it('speaks up for a message, an order, money, a queue or low stock', () => {
    const empty = { messagesIn: 0, ordersCreated: 0, revenue: 0, awaitingOwner: 0, lowStockCount: 0 };
    expect(hasSomethingToSay(facts({ ...empty, messagesIn: 1 }))).toBe(true);
    expect(hasSomethingToSay(facts({ ...empty, ordersCreated: 1 }))).toBe(true);
    expect(hasSomethingToSay(facts({ ...empty, revenue: 5 }))).toBe(true);
    expect(hasSomethingToSay(facts({ ...empty, awaitingOwner: 1 }))).toBe(true);
    expect(hasSomethingToSay(facts({ ...empty, lowStockCount: 1 }))).toBe(true);
  });
});
