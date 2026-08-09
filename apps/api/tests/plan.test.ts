import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, effectivePlan } from '../src/services/plan/plan.service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY);
}

describe('effectivePlan', () => {
  const base = {
    plan: 'BUSINESS' as const,
    trialEndsAt: null,
    suspendedAt: null,
    paystackSubCode: null,
  };

  it('uses the stored plan during an active trial', () => {
    expect(effectivePlan({ ...base, trialEndsAt: daysFromNow(7) })).toBe('BUSINESS');
  });

  it('keeps the plan inside the 48-hour grace period after the trial ends', () => {
    // The PRD is explicit that day 14 must not cut a business off mid-day;
    // access continues until day 16.
    expect(effectivePlan({ ...base, trialEndsAt: new Date(Date.now() - 12 * HOUR) })).toBe(
      'BUSINESS',
    );
    expect(effectivePlan({ ...base, trialEndsAt: new Date(Date.now() - 47 * HOUR) })).toBe(
      'BUSINESS',
    );
  });

  it('suspends once the grace period has passed with no subscription', () => {
    expect(effectivePlan({ ...base, trialEndsAt: new Date(Date.now() - 3 * DAY) })).toBe(
      'SUSPENDED',
    );
  });

  it('keeps a paying customer active even with a long-expired trial', () => {
    expect(
      effectivePlan({
        ...base,
        trialEndsAt: new Date(Date.now() - 90 * DAY),
        paystackSubCode: 'SUB_abc123',
      }),
    ).toBe('BUSINESS');
  });

  it('treats an explicitly suspended account as suspended regardless of subscription', () => {
    expect(
      effectivePlan({ ...base, suspendedAt: new Date(), paystackSubCode: 'SUB_abc123' }),
    ).toBe('SUSPENDED');
  });

  it('has no trial deadline when trialEndsAt is unset', () => {
    expect(effectivePlan(base)).toBe('BUSINESS');
  });
});

describe('PLAN_LIMITS', () => {
  it('matches the pricing table in the PRD', () => {
    expect(PLAN_LIMITS.STARTER).toEqual({
      conversations: 500,
      orders: 300,
      staff: 1,
      products: 50,
    });

    expect(PLAN_LIMITS.BUSINESS.conversations).toBe(2_000);
    expect(PLAN_LIMITS.BUSINESS.staff).toBe(5);
    expect(PLAN_LIMITS.GROWTH.conversations).toBe(10_000);
    expect(PLAN_LIMITS.GROWTH.staff).toBe(20);
  });

  it('gives paid plans unlimited orders and products', () => {
    for (const plan of ['BUSINESS', 'GROWTH', 'ENTERPRISE'] as const) {
      expect(PLAN_LIMITS[plan].orders).toBe(Number.POSITIVE_INFINITY);
      expect(PLAN_LIMITS[plan].products).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('allows nothing on a suspended account', () => {
    expect(PLAN_LIMITS.SUSPENDED).toEqual({
      conversations: 0,
      orders: 0,
      staff: 0,
      products: 0,
    });
  });

  it('never lets a higher tier offer less than a lower one', () => {
    const ladder = ['STARTER', 'BUSINESS', 'GROWTH', 'ENTERPRISE'] as const;
    const dimensions = ['conversations', 'orders', 'staff', 'products'] as const;

    for (const dimension of dimensions) {
      for (let i = 1; i < ladder.length; i += 1) {
        expect(
          PLAN_LIMITS[ladder[i]!][dimension],
          `${ladder[i]}.${dimension} must be >= ${ladder[i - 1]}.${dimension}`,
        ).toBeGreaterThanOrEqual(PLAN_LIMITS[ladder[i - 1]!][dimension]);
      }
    }
  });
});
