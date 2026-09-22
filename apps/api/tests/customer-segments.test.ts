import { describe, expect, it } from 'vitest';
import {
  bigSpenderThreshold,
  segmentFor,
  summarise,
  typicalGapDays,
  type CustomerFacts,
} from '../src/modules/customers/segments.js';

const NOW = new Date('2026-09-17T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function customer(overrides: Partial<CustomerFacts> = {}): CustomerFacts {
  return {
    id: 'c1',
    name: 'Ama',
    waNumber: '233244000111',
    totalOrders: 0,
    totalSpend: 0,
    firstOrderAt: null,
    lastOrderAt: null,
    lastInboundAt: daysAgo(1),
    createdAt: daysAgo(100),
    ...overrides,
  };
}

describe('typicalGapDays', () => {
  it('needs two orders before a rhythm exists', () => {
    expect(typicalGapDays(customer({ totalOrders: 1, firstOrderAt: daysAgo(10), lastOrderAt: daysAgo(10) }))).toBeNull();
  });

  it('averages the span across the gaps, not the orders', () => {
    // Four orders spanning 30 days is three gaps of 10, not four of 7.5.
    const gap = typicalGapDays(
      customer({ totalOrders: 4, firstOrderAt: daysAgo(30), lastOrderAt: NOW }),
    );
    expect(gap).toBe(10);
  });

  it('is null when every order landed the same day', () => {
    expect(
      typicalGapDays(customer({ totalOrders: 3, firstOrderAt: daysAgo(5), lastOrderAt: daysAgo(5) })),
    ).toBeNull();
  });
});

describe('segmentFor', () => {
  it('calls someone who never ordered a browser, however much they message', () => {
    const result = segmentFor(customer({ lastInboundAt: daysAgo(1) }), 1000, NOW);
    expect(result.segment).toBe('browser');
  });

  it('calls three months of silence gone', () => {
    const result = segmentFor(
      customer({ totalOrders: 5, totalSpend: 900, lastInboundAt: daysAgo(120), firstOrderAt: daysAgo(300), lastOrderAt: daysAgo(120) }),
      1000,
      NOW,
    );
    expect(result.segment).toBe('lapsed');
    expect(result.daysSilent).toBe(120);
  });

  it('flags a weekly buyer who has been quiet a month', () => {
    // Ten orders over 70 days is a gap of about a week. Silent 30 days is more
    // than twice that.
    const result = segmentFor(
      customer({
        totalOrders: 10,
        totalSpend: 400,
        firstOrderAt: daysAgo(100),
        lastOrderAt: daysAgo(30),
        lastInboundAt: daysAgo(30),
      }),
      1000,
      NOW,
    );
    expect(result.segment).toBe('at_risk');
  });

  it('leaves a twice-a-year buyer alone at the same 30 days of silence', () => {
    // The whole reason this is not a fixed threshold. Same silence, different
    // customer, different answer.
    const result = segmentFor(
      customer({
        totalOrders: 4,
        totalSpend: 400,
        firstOrderAt: daysAgo(700),
        lastOrderAt: daysAgo(30),
        lastInboundAt: daysAgo(30),
      }),
      1000,
      NOW,
    );
    expect(result.segment).not.toBe('at_risk');
  });

  it('does not flag someone whose two orders were hours apart', () => {
    // Their "typical gap" is nearly zero. Without a floor they are at risk by
    // the following afternoon.
    const result = segmentFor(
      customer({
        totalOrders: 2,
        totalSpend: 60,
        firstOrderAt: daysAgo(6),
        lastOrderAt: daysAgo(6),
        lastInboundAt: daysAgo(6),
      }),
      1000,
      NOW,
    );
    expect(result.segment).not.toBe('at_risk');
  });

  it('puts a quiet big spender in the at-risk list, not the trophy cabinet', () => {
    const result = segmentFor(
      customer({
        totalOrders: 12,
        totalSpend: 8000,
        firstOrderAt: daysAgo(120),
        lastOrderAt: daysAgo(40),
        lastInboundAt: daysAgo(40),
      }),
      1000,
      NOW,
    );
    expect(result.segment).toBe('at_risk');
  });

  it('recognises a best customer who is still around', () => {
    const result = segmentFor(
      customer({
        totalOrders: 12,
        totalSpend: 8000,
        firstOrderAt: daysAgo(120),
        lastOrderAt: daysAgo(3),
        lastInboundAt: daysAgo(1),
      }),
      1000,
      NOW,
    );
    expect(result.segment).toBe('big_spender');
  });

  it('calls a recent first-time buyer new', () => {
    const result = segmentFor(
      customer({ totalOrders: 1, totalSpend: 50, firstOrderAt: daysAgo(5), lastOrderAt: daysAgo(5), lastInboundAt: daysAgo(5) }),
      1000,
      NOW,
    );
    expect(result.segment).toBe('new');
  });

  it('calls a steady buyer under the big-spender line a regular', () => {
    const result = segmentFor(
      customer({
        totalOrders: 6,
        totalSpend: 300,
        firstOrderAt: daysAgo(60),
        lastOrderAt: daysAgo(4),
        lastInboundAt: daysAgo(2),
      }),
      1000,
      NOW,
    );
    expect(result.segment).toBe('regular');
  });
});

describe('bigSpenderThreshold', () => {
  it('is switched off below five paying customers, rather than crowning one of four', () => {
    expect(bigSpenderThreshold([10, 20, 30, 40])).toBe(0);
  });

  it('ignores customers who have never paid anything', () => {
    expect(bigSpenderThreshold([0, 0, 0, 0, 0, 0])).toBe(0);
  });

  it('sits at the eightieth percentile of what people actually spend', () => {
    // Ten payers: the threshold is the ninth smallest, so two qualify.
    const spends = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const threshold = bigSpenderThreshold(spends);
    expect(threshold).toBe(90);
    expect(spends.filter((s) => s >= threshold)).toEqual([90, 100]);
  });
});

describe('summarise', () => {
  it('reports every segment, including the empty ones', () => {
    const rows = summarise([
      segmentFor(customer({ id: 'a' }), 0, NOW),
      segmentFor(customer({ id: 'b' }), 0, NOW),
    ]);

    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.segment === 'browser')?.count).toBe(2);
    // An empty segment showing 0 is information; a missing row is a gap the UI
    // then has to guess about.
    expect(rows.find((r) => r.segment === 'lapsed')?.count).toBe(0);
  });
});
