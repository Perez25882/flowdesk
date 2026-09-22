import { describe, expect, it, vi } from 'vitest';
import { BillingFakeRedis } from './billing-fake-redis.js';

/**
 * What a business is entitled to during and after its free trial.
 *
 * The PRD sells a 14-day trial "on the Business plan… full feature access" and
 * the landing page repeats it, but registration only stamped `trialEndsAt` and
 * left `plan` at the schema default of STARTER — so the trial actually ran on
 * 50 products and one staff seat, both hard-enforced. These tests pin the
 * entitlement rule and, just as importantly, the two dates either side of it:
 * a trial must not end early, and it must not run forever.
 *
 * DB-free: `plan.service` reaches Prisma and Redis at import, so both are
 * mocked at the module boundary. Nothing here touches either.
 */

vi.mock('../src/config/redis.js', () => ({ redis: new BillingFakeRedis() }));
vi.mock('../src/config/database.js', () => ({ prisma: {} }));

const { TRIAL_GRACE_MS, comparePlans, effectivePlan, higherPlan, trialState } = await import(
  '../src/services/plan/plan.service.js'
);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function inDays(days: number): Date {
  return new Date(Date.now() + days * DAY);
}

const base = {
  // The plan every business is created with, because the schema default is
  // STARTER and nothing at signup changes it.
  plan: 'STARTER' as const,
  trialEndsAt: null as Date | null,
  suspendedAt: null as Date | null,
  paystackSubCode: null as string | null,
};

describe('effectivePlan during a trial', () => {
  it('gives a brand-new business the Business plan, not the stored Starter', () => {
    expect(effectivePlan({ ...base, trialEndsAt: inDays(14) })).toBe('BUSINESS');
  });

  it('still gives Business one millisecond before the grace period closes', () => {
    const trialEndsAt = new Date(Date.now() - TRIAL_GRACE_MS + 60_000);
    expect(effectivePlan({ ...base, trialEndsAt })).toBe('BUSINESS');
  });

  it('suspends one minute after the grace period closes', () => {
    const trialEndsAt = new Date(Date.now() - TRIAL_GRACE_MS - 60_000);
    expect(effectivePlan({ ...base, trialEndsAt })).toBe('SUSPENDED');
  });

  it('does not pull a mid-trial Growth buyer back down to Business', () => {
    // They have paid for Growth. Handing them Business until day 14 would take
    // away limits they are being charged for.
    expect(
      effectivePlan({
        ...base,
        plan: 'GROWTH',
        trialEndsAt: inDays(9),
        paystackSubCode: 'SUB_growth',
      }),
    ).toBe('GROWTH');
  });

  it('does not cut a mid-trial Starter buyer down to Starter before day 14', () => {
    // Buying the cheapest plan on day 3 must not delete the trial they were
    // promised: paying early should never cost someone features.
    expect(
      effectivePlan({
        ...base,
        plan: 'STARTER',
        trialEndsAt: inDays(11),
        paystackSubCode: 'SUB_starter',
      }),
    ).toBe('BUSINESS');
  });

  it('drops that Starter buyer to Starter once the trial and grace are over', () => {
    expect(
      effectivePlan({
        ...base,
        plan: 'STARTER',
        trialEndsAt: inDays(-30),
        paystackSubCode: 'SUB_starter',
      }),
    ).toBe('STARTER');
  });

  it('treats a lapsed plan as suspended even inside the trial window', () => {
    // A cancellation that has already been written through says SUSPENDED on
    // the row itself; a trial date left over from signup must not undo it.
    expect(effectivePlan({ ...base, plan: 'SUSPENDED', trialEndsAt: inDays(5) })).toBe('SUSPENDED');
  });

  it('treats an explicitly suspended account as suspended regardless of the trial', () => {
    expect(
      effectivePlan({ ...base, trialEndsAt: inDays(5), suspendedAt: new Date() }),
    ).toBe('SUSPENDED');
  });

  it('leaves a business with no trial date on its stored plan', () => {
    expect(effectivePlan({ ...base, plan: 'GROWTH' })).toBe('GROWTH');
  });
});

describe('plan ordering', () => {
  it('ranks the tiers the way the pricing table does', () => {
    expect(comparePlans('STARTER', 'BUSINESS')).toBeLessThan(0);
    expect(comparePlans('GROWTH', 'BUSINESS')).toBeGreaterThan(0);
    expect(comparePlans('BUSINESS', 'BUSINESS')).toBe(0);
    expect(comparePlans('SUSPENDED', 'STARTER')).toBeLessThan(0);
  });

  it('picks the more generous of two plans', () => {
    expect(higherPlan('STARTER', 'BUSINESS')).toBe('BUSINESS');
    expect(higherPlan('GROWTH', 'BUSINESS')).toBe('GROWTH');
    expect(higherPlan('ENTERPRISE', 'GROWTH')).toBe('ENTERPRISE');
  });
});

describe('trialState — the countdown PRD 3.10 asks the dashboard to render', () => {
  const noSubscription = { paystackSubCode: null };

  it('says nothing while the trial is young', () => {
    const state = trialState({ ...noSubscription, trialEndsAt: inDays(7) });
    expect(state.stage).toBe('none');
    expect(state.daysRemaining).toBe(7);
    expect(state.active).toBe(true);
  });

  it('prompts from day 10, which is four days out', () => {
    expect(trialState({ ...noSubscription, trialEndsAt: inDays(5) }).stage).toBe('none');
    expect(
      trialState({ ...noSubscription, trialEndsAt: new Date(Date.now() + 4 * DAY - HOUR) }).stage,
    ).toBe('prompt');
    expect(
      trialState({ ...noSubscription, trialEndsAt: new Date(Date.now() + 2 * DAY - HOUR) }).stage,
    ).toBe('prompt');
  });

  it('warns "one day left" on day 13', () => {
    const state = trialState({
      ...noSubscription,
      trialEndsAt: new Date(Date.now() + DAY - HOUR),
    });
    expect(state.stage).toBe('final_day');
    expect(state.daysRemaining).toBe(1);
  });

  it('reports the day-14 state through the 48-hour grace, not a lockout', () => {
    const state = trialState({
      ...noSubscription,
      trialEndsAt: new Date(Date.now() - HOUR),
    });
    expect(state.stage).toBe('ended');
    expect(state.daysRemaining).toBe(0);
    expect(state.active).toBe(true);
  });

  it('reports lapsed once the grace has run out', () => {
    const state = trialState({
      ...noSubscription,
      trialEndsAt: new Date(Date.now() - TRIAL_GRACE_MS - HOUR),
    });
    expect(state.stage).toBe('lapsed');
    expect(state.active).toBe(false);
  });

  it('stops counting down at somebody who has already paid', () => {
    const state = trialState({
      trialEndsAt: new Date(Date.now() + DAY),
      paystackSubCode: 'SUB_paid',
    });
    expect(state.stage).toBe('none');
    expect(state.active).toBe(false);
  });

  it('has no countdown at all when there is no trial date', () => {
    expect(trialState({ trialEndsAt: null, paystackSubCode: null })).toEqual({
      active: false,
      endsAt: null,
      graceEndsAt: null,
      daysRemaining: null,
      stage: 'none',
    });
  });
});
