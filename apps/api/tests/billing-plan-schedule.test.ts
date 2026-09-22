import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingFakeRedis } from './billing-fake-redis.js';

/**
 * Plan changes that take effect later: downgrades, cancellations, pauses, and
 * the 3-day grace the PRD gives a failed payment.
 *
 * There is no scheduler in this service, so a change is decided now, stored
 * with the date it becomes true, and written through on the next read. These
 * tests cover the three things that has to get right: it must not apply early,
 * it must apply exactly once when it is due, and a lapse must leave the account
 * able to pay again rather than sealed shut.
 */

const redis = new BillingFakeRedis();

const mocks = vi.hoisted(() => ({
  businessUpdate: vi.fn(),
}));

vi.mock('../src/config/redis.js', () => ({ redis }));
vi.mock('../src/config/database.js', () => ({
  prisma: { business: { update: mocks.businessUpdate } },
}));

const {
  PAYMENT_GRACE_MS,
  applyDueScheduledChange,
  claimSchedule,
  clearSchedule,
  readSchedule,
  startPaymentGrace,
  withChangeLock,
} = await import('../src/services/billing/plan-schedule.js');

const BUSINESS_ID = 'biz_1';
const KEY = `flowdesk:billing:schedule:${BUSINESS_ID}`;
const DAY = 24 * 60 * 60 * 1000;

function change(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS_ID,
    kind: 'downgrade' as const,
    targetPlan: 'STARTER' as const,
    effectiveAt: new Date(Date.now() + 12 * DAY).toISOString(),
    previousPlan: 'GROWTH' as const,
    subscriptionCode: 'SUB_old',
    replacementSubscriptionCode: 'SUB_new',
    requiresCheckout: false,
    appliedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  redis.store.clear();
  redis.failing = false;
  mocks.businessUpdate.mockReset();
  mocks.businessUpdate.mockResolvedValue({});
});

describe('claiming a schedule', () => {
  it('records the change', async () => {
    expect(await claimSchedule(change())).toBe(true);
    expect((await readSchedule(BUSINESS_ID))?.targetPlan).toBe('STARTER');
  });

  it('refuses a second change while one is still pending', async () => {
    await claimSchedule(change());

    // A double-clicked "Cancel my plan" must not disable the subscription
    // twice, and a webhook arriving mid-request must not start a second,
    // contradictory change.
    expect(await claimSchedule(change({ kind: 'cancel', targetPlan: 'SUSPENDED' }))).toBe(false);
    expect((await readSchedule(BUSINESS_ID))?.kind).toBe('downgrade');
  });

  it('replaces a change that has already been applied', async () => {
    await claimSchedule(change({ appliedAt: new Date().toISOString() }));

    // History, not a claim: a business that lapsed last month must still be
    // able to schedule something new.
    expect(await claimSchedule(change({ kind: 'cancel', targetPlan: 'SUSPENDED' }))).toBe(true);
    expect((await readSchedule(BUSINESS_ID))?.kind).toBe('cancel');
  });

  it('throws rather than silently losing the record when Redis is down', async () => {
    redis.failing = true;

    // The caller is about to stop a subscription at Paystack. Doing that with
    // no record of why is how a customer ends up cancelled and unexplained, so
    // the failure has to reach them.
    await expect(claimSchedule(change())).rejects.toThrow();
  });
});

describe('applying a change when it falls due', () => {
  it('does nothing before the effective date', async () => {
    await claimSchedule(change());
    await applyDueScheduledChange(BUSINESS_ID);

    // The customer paid for Growth through the end of the period. Cutting them
    // to Starter today would be taking money for something withdrawn.
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
    expect((await readSchedule(BUSINESS_ID))?.appliedAt).toBeNull();
  });

  it('moves the business to the cheaper plan once the paid period ends', async () => {
    await claimSchedule(change({ effectiveAt: new Date(Date.now() - 60_000).toISOString() }));
    await applyDueScheduledChange(BUSINESS_ID);

    expect(mocks.businessUpdate).toHaveBeenCalledWith({
      where: { id: BUSINESS_ID },
      data: { plan: 'STARTER', paystackSubCode: 'SUB_new', suspendReason: null },
    });
  });

  it('applies once, however many times it is read', async () => {
    await claimSchedule(change({ effectiveAt: new Date(Date.now() - 60_000).toISOString() }));

    await applyDueScheduledChange(BUSINESS_ID);
    await applyDueScheduledChange(BUSINESS_ID);
    await applyDueScheduledChange(BUSINESS_ID);

    expect(mocks.businessUpdate).toHaveBeenCalledTimes(1);
    expect((await readSchedule(BUSINESS_ID))?.appliedAt).not.toBeNull();
  });

  it('leaves the change pending when the database write fails', async () => {
    mocks.businessUpdate.mockRejectedValueOnce(new Error('connection lost'));
    await claimSchedule(change({ effectiveAt: new Date(Date.now() - 60_000).toISOString() }));

    await applyDueScheduledChange(BUSINESS_ID);
    expect((await readSchedule(BUSINESS_ID))?.appliedAt).toBeNull();

    await applyDueScheduledChange(BUSINESS_ID);
    expect((await readSchedule(BUSINESS_ID))?.appliedAt).not.toBeNull();
  });

  it('lapses a cancellation without stamping suspendedAt', async () => {
    await claimSchedule(
      change({
        kind: 'cancel',
        targetPlan: 'SUSPENDED',
        previousPlan: 'BUSINESS',
        replacementSubscriptionCode: null,
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    await applyDueScheduledChange(BUSINESS_ID);

    const [[call]] = mocks.businessUpdate.mock.calls as [[{ data: Record<string, unknown> }]];

    // `suspendedAt` is a flat 403 across the whole API, /billing/ included —
    // which would lock a cancelled customer out of the one page where they
    // could come back. The plan column carries the lapse instead.
    expect(call.data.suspendedAt).toBeUndefined();
    expect(call.data.plan).toBe('SUSPENDED');
    expect(call.data.paystackSubCode).toBeNull();
    expect(call.data.suspendReason).toContain('BUSINESS');
  });

  it('says the plan is waiting, not gone, when a pause lapses', async () => {
    await claimSchedule(
      change({
        kind: 'pause',
        targetPlan: 'SUSPENDED',
        previousPlan: 'BUSINESS',
        replacementSubscriptionCode: null,
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    await applyDueScheduledChange(BUSINESS_ID);

    const [[call]] = mocks.businessUpdate.mock.calls as [[{ data: Record<string, string> }]];
    expect(call.data.suspendReason).toMatch(/paused/i);
  });

  it('keeps the record after applying, so a pause knows what to restore', async () => {
    await claimSchedule(
      change({
        kind: 'pause',
        targetPlan: 'SUSPENDED',
        previousPlan: 'GROWTH',
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    await applyDueScheduledChange(BUSINESS_ID);

    expect((await readSchedule(BUSINESS_ID))?.previousPlan).toBe('GROWTH');
  });

  it('reads as no schedule at all when Redis is unavailable', async () => {
    await claimSchedule(change({ effectiveAt: new Date(Date.now() - 60_000).toISOString() }));
    redis.failing = true;

    // Losing the record means the business keeps the plan it is on. That is the
    // direction to fail in: nobody is cut off or downgraded by a record that
    // vanished.
    await applyDueScheduledChange(BUSINESS_ID);
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });
});

describe('the failed-payment grace period', () => {
  it('gives three days before anything stops', async () => {
    expect(await startPaymentGrace(BUSINESS_ID, 'BUSINESS', 'SUB_old')).toBe(true);

    const stored = redis.json<{ effectiveAt: string; targetPlan: string }>(KEY);
    const gap = new Date(stored!.effectiveAt).getTime() - Date.now();

    expect(stored!.targetPlan).toBe('SUSPENDED');
    expect(gap).toBeGreaterThan(PAYMENT_GRACE_MS - 60_000);
    expect(gap).toBeLessThanOrEqual(PAYMENT_GRACE_MS);
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it('does not restart the clock on a repeated failure notice', async () => {
    await startPaymentGrace(BUSINESS_ID, 'BUSINESS', 'SUB_old');
    const first = redis.json<{ effectiveAt: string }>(KEY)!.effectiveAt;

    expect(await startPaymentGrace(BUSINESS_ID, 'BUSINESS', 'SUB_old')).toBe(false);
    expect(redis.json<{ effectiveAt: string }>(KEY)!.effectiveAt).toBe(first);
  });

  it('refuses to turn a change we asked for into a suspension', async () => {
    await claimSchedule(change({ kind: 'cancel', targetPlan: 'SUSPENDED' }));

    expect(await startPaymentGrace(BUSINESS_ID, 'GROWTH', 'SUB_old')).toBe(false);
    expect((await readSchedule(BUSINESS_ID))?.kind).toBe('cancel');
  });

  it('stops the account once the three days are up', async () => {
    await startPaymentGrace(BUSINESS_ID, 'BUSINESS', 'SUB_old');

    const stored = redis.json<Record<string, unknown>>(KEY)!;
    stored.effectiveAt = new Date(Date.now() - 1000).toISOString();
    redis.store.set(KEY, JSON.stringify(stored));

    await applyDueScheduledChange(BUSINESS_ID);

    const [[call]] = mocks.businessUpdate.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(call.data.plan).toBe('SUSPENDED');
    expect(call.data.suspendedAt).toBeUndefined();
  });
});

describe('the change lock', () => {
  it('lets one caller through and turns the other away', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withChangeLock(BUSINESS_ID, async () => {
      await held;
      return 'first';
    });

    // Two overlapping changes would disable one subscription twice or create
    // two replacements, so the second is refused rather than queued.
    expect(await withChangeLock(BUSINESS_ID, async () => 'second')).toEqual({
      ok: false,
      reason: 'held',
    });

    release();
    expect(await first).toEqual({ ok: true, value: 'first' });
  });

  it('releases the lock even when the work throws', async () => {
    await expect(
      withChangeLock(BUSINESS_ID, async () => {
        throw new Error('paystack refused');
      }),
    ).rejects.toThrow('paystack refused');

    expect(await withChangeLock(BUSINESS_ID, async () => 'after')).toEqual({
      ok: true,
      value: 'after',
    });
  });

  it('reports a Redis outage separately from a lock that is simply held', async () => {
    redis.failing = true;

    // The caller says "nothing was changed" on the strength of this, so it must
    // not be confused with somebody else holding the lock.
    expect(await withChangeLock(BUSINESS_ID, async () => 'never')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('clearing a schedule', () => {
  it('drops a change that was called off', async () => {
    await claimSchedule(change());
    await clearSchedule(BUSINESS_ID);

    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });
});
