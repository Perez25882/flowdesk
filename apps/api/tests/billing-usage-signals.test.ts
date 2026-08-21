import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingFakeRedis } from './billing-fake-redis.js';

/**
 * The usage numbers and the warnings drawn from them.
 *
 * The 90%-of-limit flag was computed on every read and then dropped, because
 * nothing exposed it — an owner sailed past 90% of their conversations with no
 * hint until the automatic replies went quiet. These tests pin the figures, the
 * two thresholds, and the claims the messages make about what actually stops:
 * conversations and seats block, orders never do.
 */

const redis = new BillingFakeRedis();

const mocks = vi.hoisted(() => ({
  businessFindUnique: vi.fn(),
  businessUpdate: vi.fn(),
  staffCount: vi.fn(),
  productCount: vi.fn(),
}));

vi.mock('../src/config/redis.js', () => ({ redis }));
vi.mock('../src/config/database.js', () => ({
  prisma: {
    business: { findUnique: mocks.businessFindUnique, update: mocks.businessUpdate },
    staff: { count: mocks.staffCount },
    product: { count: mocks.productCount },
  },
}));

const { downgradeConflicts, getUsage, usageWarnings } = await import(
  '../src/services/plan/plan.service.js'
);

const BUSINESS_ID = 'biz_1';
const NEXT_MONTH = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

function businessRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    plan: 'STARTER',
    trialEndsAt: null,
    suspendedAt: null,
    paystackSubCode: 'SUB_live',
    monthlyConvoCount: 0,
    convoCountResetAt: NEXT_MONTH,
    monthlyOrderCount: 0,
    orderCountResetAt: NEXT_MONTH,
    ...overrides,
  };
}

beforeEach(() => {
  redis.store.clear();
  mocks.businessUpdate.mockReset().mockResolvedValue({});
  mocks.staffCount.mockReset().mockResolvedValue(0);
  mocks.productCount.mockReset().mockResolvedValue(10);
  mocks.businessFindUnique.mockReset();
});

describe('getUsage', () => {
  it('reports what is used, what is left and when the month turns over', async () => {
    mocks.businessFindUnique.mockResolvedValue(
      businessRow({ monthlyConvoCount: 120, monthlyOrderCount: 40 }),
    );

    const usage = await getUsage(BUSINESS_ID);

    expect(usage?.conversations).toEqual({
      used: 120,
      limit: 500,
      remaining: 380,
      nearLimit: false,
      overLimit: false,
    });
    expect(usage?.periodEndsAt).toEqual(NEXT_MONTH);
    expect(usage?.effectivePlan).toBe('STARTER');
  });

  it('measures against the trial plan, not the stored one, during a trial', async () => {
    mocks.businessFindUnique.mockResolvedValue(
      businessRow({
        paystackSubCode: null,
        trialEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        monthlyConvoCount: 600,
      }),
    );

    const usage = await getUsage(BUSINESS_ID);

    // On the stored Starter plan this would read as 100 over the limit, with
    // automatic replies already paused, on day nine of a trial sold as "full
    // feature access".
    expect(usage?.effectivePlan).toBe('BUSINESS');
    expect(usage?.conversations.limit).toBe(2_000);
    expect(usage?.conversations.overLimit).toBe(false);
    expect(usage?.products.limit).toBe(Number.POSITIVE_INFINITY);
  });

  it('flags 90% as near and 100% as over', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ monthlyConvoCount: 450 }));
    expect((await getUsage(BUSINESS_ID))?.conversations).toMatchObject({
      nearLimit: true,
      overLimit: false,
    });

    mocks.businessFindUnique.mockResolvedValue(businessRow({ monthlyConvoCount: 500 }));
    expect((await getUsage(BUSINESS_ID))?.conversations).toMatchObject({
      nearLimit: true,
      overLimit: true,
    });
  });
});

describe('usageWarnings', () => {
  async function warningsFor(overrides: Record<string, unknown>) {
    mocks.businessFindUnique.mockResolvedValue(businessRow(overrides));
    const usage = await getUsage(BUSINESS_ID);
    return usageWarnings(usage!);
  }

  it('says nothing while everything is comfortable', async () => {
    expect(await warningsFor({ monthlyConvoCount: 100 })).toEqual([]);
  });

  it('warns before the automatic replies stop', async () => {
    const [warning] = await warningsFor({ monthlyConvoCount: 460 });

    expect(warning).toMatchObject({ resource: 'conversations', level: 'near', blocking: true });
    expect(warning?.message).toMatch(/pause/i);
  });

  it('tells an owner past their order allowance that nothing is blocked', async () => {
    const warnings = await warningsFor({ monthlyOrderCount: 320 });
    const orders = warnings.find((w) => w.resource === 'orders');

    // The PRD is explicit that orders are counted and never refused. The
    // warning has to make that promise out loud, or it reads as a threat.
    expect(orders).toMatchObject({ level: 'over', blocking: false });
    expect(orders?.message).toMatch(/nothing is blocked|no order is lost/i);
  });

  it('never warns about a limit the plan does not have', async () => {
    mocks.productCount.mockResolvedValue(4_000);
    mocks.staffCount.mockResolvedValue(4);
    mocks.businessFindUnique.mockResolvedValue(businessRow({ plan: 'BUSINESS' }));

    const usage = await getUsage(BUSINESS_ID);
    expect(usageWarnings(usage!).some((w) => w.resource === 'products')).toBe(false);
  });
});

describe('downgradeConflicts', () => {
  async function conflicts(target: 'STARTER' | 'BUSINESS', overrides: Record<string, unknown>) {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ plan: 'GROWTH', ...overrides }));
    const usage = await getUsage(BUSINESS_ID);
    return downgradeConflicts(usage!, target);
  }

  it('finds nothing when the business fits inside the cheaper plan', async () => {
    mocks.productCount.mockResolvedValue(12);
    expect(await conflicts('STARTER', { monthlyConvoCount: 10 })).toEqual([]);
  });

  it('says the catalogue stays put and only new products are blocked', async () => {
    mocks.productCount.mockResolvedValue(120);

    const [products] = await conflicts('STARTER', {});

    expect(products).toMatchObject({ resource: 'products', used: 120, limitAfter: 50 });
    expect(products?.message).toMatch(/stays exactly where it is/i);
  });

  it('counts staff seats that would be over the line', async () => {
    mocks.staffCount.mockResolvedValue(6);
    mocks.productCount.mockResolvedValue(3);

    const staff = (await conflicts('STARTER', {})).find((c) => c.resource === 'staff');

    expect(staff).toMatchObject({ used: 6, limitAfter: 1, blocking: true });
    expect(staff?.message).toMatch(/deactivate 5/);
  });

  it('marks an order overage as something that will not block anything', async () => {
    mocks.productCount.mockResolvedValue(3);

    const orders = (await conflicts('STARTER', { monthlyOrderCount: 400 })).find(
      (c) => c.resource === 'orders',
    );

    expect(orders).toMatchObject({ blocking: false });
  });
});
