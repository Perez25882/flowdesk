import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingFakeRedis } from './billing-fake-redis.js';

/**
 * The plan-management endpoints the Settings screen calls.
 *
 * Before these existed, `POST /billing/checkout` was the only billing route, so
 * "Switch to this" opened a full-price transaction even for a cheaper tier and
 * there was no way at all to cancel or pause. The contract these tests pin down
 * is mostly about *when* money moves: a downgrade must land at the end of the
 * period already paid for, a cancellation must not cut anyone off on the day
 * they ask, and neither may touch Paystack without a record of why.
 */

const redis = new BillingFakeRedis();

const mocks = vi.hoisted(() => ({
  businessFindUnique: vi.fn(),
  businessUpdate: vi.fn(),
  staffCount: vi.fn(),
  productCount: vi.fn(),
  fetchSubscription: vi.fn(),
  disableSubscription: vi.fn(),
  enableSubscription: vi.fn(),
  createSubscription: vi.fn(),
  initializeTransaction: vi.fn(),
  createPaystackCustomer: vi.fn(),
}));

vi.mock('../src/config/redis.js', () => ({ redis }));
vi.mock('../src/config/database.js', () => ({
  prisma: {
    business: { findUnique: mocks.businessFindUnique, update: mocks.businessUpdate },
    staff: { count: mocks.staffCount },
    product: { count: mocks.productCount },
  },
}));
vi.mock('../src/services/billing/paystack.js', () => ({
  fetchSubscription: mocks.fetchSubscription,
  disableSubscription: mocks.disableSubscription,
  enableSubscription: mocks.enableSubscription,
  createSubscription: mocks.createSubscription,
  initializeTransaction: mocks.initializeTransaction,
}));
vi.mock('../src/services/billing/paystack-customer.js', () => ({
  createPaystackCustomer: mocks.createPaystackCustomer,
}));

const billingCheckoutRoutes = (await import('../src/modules/billing/billingCheckout.route.js'))
  .default;
const { readSchedule } = await import('../src/services/billing/plan-schedule.js');

const BUSINESS_ID = 'biz_1';
const SUB_CODE = 'SUB_live';
const DAY = 24 * 60 * 60 * 1000;
const NEXT_PAYMENT = new Date(Date.now() + 12 * DAY).toISOString();

let businessContext: Record<string, unknown>;

function business(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    name: 'Ama Provisions',
    ownerName: 'Ama',
    phone: null,
    email: 'ama@example.com',
    plan: 'GROWTH',
    trialEndsAt: null,
    suspendedAt: null,
    suspendReason: null,
    active: true,
    paystackSubCode: SUB_CODE,
    paystackCustomerId: 'CUS_1',
    ...overrides,
  };
}

/** The row `plan.service` reads, kept in step with the request context. */
function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    plan: businessContext.plan,
    trialEndsAt: businessContext.trialEndsAt,
    suspendedAt: null,
    paystackSubCode: businessContext.paystackSubCode,
    monthlyConvoCount: 0,
    convoCountResetAt: new Date(Date.now() + 20 * DAY),
    monthlyOrderCount: 0,
    orderCountResetAt: new Date(Date.now() + 20 * DAY),
    suspendReason: null,
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();

  // Stands in for `requireAuth` + `attachBusinessContext`, which the real app
  // applies to the whole authenticated sub-app this plugin is mounted in.
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.user = { businessId: BUSINESS_ID, plan: 'GROWTH' };
    request.business = businessContext as FastifyRequest['business'];
  });

  await app.register(billingCheckoutRoutes);
  return app;
}

function activeSubscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscriptionCode: SUB_CODE,
    emailToken: 'tok_live',
    status: 'active',
    nextPaymentDate: NEXT_PAYMENT,
    planCode: 'PLN_growth',
    amountMinor: 700_00,
    customerCode: 'CUS_1',
    authorizationCode: 'AUTH_1',
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  redis.store.clear();
  redis.failing = false;
  businessContext = business();

  // A deployment with its Paystack plans configured — which is what makes a
  // checkout a subscription and gives a downgrade something to defer.
  process.env.PAYSTACK_PLAN_STARTER = 'PLN_starter';
  process.env.PAYSTACK_PLAN_BUSINESS = 'PLN_business';
  process.env.PAYSTACK_PLAN_GROWTH = 'PLN_growth';

  mocks.businessUpdate.mockReset().mockResolvedValue({});
  mocks.staffCount.mockReset().mockResolvedValue(2);
  mocks.productCount.mockReset().mockResolvedValue(12);
  mocks.businessFindUnique.mockReset().mockImplementation(async () => planRow());
  mocks.fetchSubscription.mockReset().mockResolvedValue(activeSubscription());
  mocks.disableSubscription.mockReset().mockResolvedValue(true);
  mocks.enableSubscription.mockReset().mockResolvedValue(true);
  mocks.createSubscription.mockReset().mockResolvedValue(null);
  mocks.initializeTransaction.mockReset().mockResolvedValue({
    authorizationUrl: 'https://checkout.paystack.com/abc',
    accessCode: 'acc',
    reference: 'ref_1',
  });
  mocks.createPaystackCustomer.mockReset().mockResolvedValue('CUS_1');

  app = await buildApp();
});

afterEach(() => {
  delete process.env.PAYSTACK_PLAN_STARTER;
  delete process.env.PAYSTACK_PLAN_BUSINESS;
  delete process.env.PAYSTACK_PLAN_GROWTH;
});

async function post(url: string, payload: unknown = {}) {
  const response = await app.inject({ method: 'POST', url, payload });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

describe('GET /billing/state', () => {
  it('returns the plan, the countdown, the usage and the warnings in one read', async () => {
    const response = await app.inject({ method: 'GET', url: '/billing/state' });
    const { data } = response.json() as { data: Record<string, any> };

    expect(response.statusCode).toBe(200);
    expect(data.plan).toBe('GROWTH');
    expect(data.effectivePlan).toBe('GROWTH');
    expect(data.subscription).toMatchObject({ code: SUB_CODE });
    expect(data.trial).toMatchObject({ active: false, stage: 'none' });
    expect(data.usage.conversations).toMatchObject({ used: 0, limit: 10_000, overLimit: false });
    // Unlimited is a deliberate null, not `Infinity` quietly becoming one.
    expect(data.usage.products.limit).toBeNull();
    expect(data.warnings).toEqual([]);
    expect(data.scheduledChange).toBeNull();
  });

  it('shows a trialing business the plan it is actually entitled to', async () => {
    businessContext = business({
      plan: 'STARTER',
      paystackSubCode: null,
      trialEndsAt: new Date(Date.now() + 3 * DAY - 60 * 60 * 1000),
    });

    const response = await app.inject({ method: 'GET', url: '/billing/state' });
    const { data } = response.json() as { data: Record<string, any> };

    expect(data.plan).toBe('STARTER');
    expect(data.effectivePlan).toBe('BUSINESS');
    expect(data.trial).toMatchObject({ stage: 'prompt', daysRemaining: 3, active: true });
  });
});

describe('POST /billing/downgrade', () => {
  it('previews rather than commits when the business is over the lower limits', async () => {
    mocks.productCount.mockResolvedValue(120);

    const { status, body } = await post('/billing/downgrade', { plan: 'STARTER' });

    expect(status).toBe(200);
    expect(body.data.scheduled).toBe(false);
    expect(body.data.requiresConfirmation).toBe(true);
    expect(body.data.conflicts[0]).toMatchObject({ resource: 'products', limitAfter: 50 });
    expect(body.data.effectiveAt).toBe(NEXT_PAYMENT);

    // Nothing may be touched at Paystack before the owner has seen that.
    expect(mocks.disableSubscription).not.toHaveBeenCalled();
    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });

  it('schedules the change for the end of the paid period once confirmed', async () => {
    mocks.productCount.mockResolvedValue(120);
    mocks.createSubscription.mockResolvedValue(
      activeSubscription({ subscriptionCode: 'SUB_starter' }),
    );

    const { status, body } = await post('/billing/downgrade', { plan: 'STARTER', confirm: true });

    expect(status).toBe(200);
    expect(body.data.scheduled).toBe(true);
    expect(body.data.effectiveAt).toBe(NEXT_PAYMENT);
    expect(body.data.requiresCheckout).toBe(false);
    expect(body.data.amountMinorAtRenewal).toBe(150_00);

    // The plan itself does not move today — that is the whole point.
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
    expect(mocks.disableSubscription).toHaveBeenCalledWith(SUB_CODE, 'tok_live');
    expect(mocks.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: NEXT_PAYMENT, authorization: 'AUTH_1' }),
    );
    expect(await readSchedule(BUSINESS_ID)).toMatchObject({
      kind: 'downgrade',
      targetPlan: 'STARTER',
      replacementSubscriptionCode: 'SUB_starter',
    });
  });

  it('commits straight away when nothing is over the line', async () => {
    const { body } = await post('/billing/downgrade', { plan: 'BUSINESS' });

    expect(body.data.scheduled).toBe(true);
    expect(body.data.conflicts).toEqual([]);
  });

  it('says so plainly when the cheaper plan has no automatic payment behind it', async () => {
    // Mobile money may leave no reusable authorization, so Paystack refuses the
    // deferred subscription. Under-billing beats double-billing: the change
    // still stands and the owner is told they will be asked to pay on the day.
    mocks.createSubscription.mockResolvedValue(null);

    const { body } = await post('/billing/downgrade', { plan: 'STARTER', confirm: true });

    expect(body.data.requiresCheckout).toBe(true);
    expect(body.data.message).toMatch(/pay for it on the day/i);
    expect((await readSchedule(BUSINESS_ID))?.requiresCheckout).toBe(true);
  });

  it('refuses a plan that is not actually cheaper', async () => {
    const { status, body } = await post('/billing/downgrade', { plan: 'BUSINESS', confirm: true });
    expect(status).toBe(200);

    const up = await post('/billing/downgrade', { plan: 'GROWTH' });
    expect(up.status).toBe(400);
    expect(up.body.code).toBe('NOT_A_DOWNGRADE');
    expect(body.data.scheduled).toBe(true);
  });

  it('refuses when there is no subscription to change', async () => {
    businessContext = business({ paystackSubCode: null });

    const { status, body } = await post('/billing/downgrade', { plan: 'STARTER' });

    expect(status).toBe(409);
    expect(body.code).toBe('NO_ACTIVE_SUBSCRIPTION');
  });

  it('leaves the subscription alone when the record cannot be written', async () => {
    // Changing a subscription with nothing recorded is how a customer ends up
    // cancelled and unexplained, so the whole request stops instead.
    redis.failing = true;

    const { status, body } = await post('/billing/downgrade', { plan: 'STARTER', confirm: true });

    expect(status).toBe(503);
    expect(body.code).toBe('BILLING_UNAVAILABLE');
    expect(mocks.disableSubscription).not.toHaveBeenCalled();
  });

  it('rolls the schedule back when Paystack will not stop the subscription', async () => {
    mocks.disableSubscription.mockResolvedValue(false);

    const { status, body } = await post('/billing/downgrade', { plan: 'STARTER', confirm: true });

    expect(status).toBe(502);
    expect(body.code).toBe('PAYSTACK_UNAVAILABLE');
    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });

  it('refuses a second change while one is already scheduled', async () => {
    await post('/billing/downgrade', { plan: 'BUSINESS', confirm: true });

    const second = await post('/billing/cancel');

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CHANGE_ALREADY_SCHEDULED');
    expect(mocks.disableSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('POST /billing/cancel and /billing/pause', () => {
  it('runs the plan to the end of the paid period rather than cutting it off', async () => {
    const { status, body } = await post('/billing/cancel');

    expect(status).toBe(200);
    expect(body.data.accessUntil).toBe(NEXT_PAYMENT);
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
    expect(mocks.disableSubscription).toHaveBeenCalledWith(SUB_CODE, 'tok_live');
    expect(await readSchedule(BUSINESS_ID)).toMatchObject({
      kind: 'cancel',
      targetPlan: 'SUSPENDED',
      previousPlan: 'GROWTH',
    });
  });

  it('records a pause as a pause, so the plan can be offered straight back', async () => {
    const { body } = await post('/billing/pause', { reason: 'slow season' });

    expect(body.data.kind).toBe('pause');
    expect(body.data.resumable).toBe(true);
    expect((await readSchedule(BUSINESS_ID))?.kind).toBe('pause');
  });

  it('refuses when there is nothing to stop', async () => {
    businessContext = business({ paystackSubCode: null });

    const { status, body } = await post('/billing/cancel');

    expect(status).toBe(409);
    expect(body.code).toBe('NO_ACTIVE_SUBSCRIPTION');
  });

  it('refuses when Paystack has no next payment date left to schedule against', async () => {
    mocks.fetchSubscription.mockResolvedValue(
      activeSubscription({ status: 'cancelled', nextPaymentDate: null }),
    );

    const { status, body } = await post('/billing/cancel');

    expect(status).toBe(409);
    expect(body.code).toBe('SUBSCRIPTION_NOT_ACTIVE');
  });
});

describe('POST /billing/resume', () => {
  it('puts a paused subscription straight back before the period ends', async () => {
    await post('/billing/pause');

    const { status, body } = await post('/billing/resume');

    expect(status).toBe(200);
    expect(body.data.resumed).toBe(true);
    expect(mocks.enableSubscription).toHaveBeenCalledWith(SUB_CODE, 'tok_live');
    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });

  it('removes the queued cheaper subscription when a downgrade is called off', async () => {
    mocks.createSubscription.mockResolvedValue(
      activeSubscription({ subscriptionCode: 'SUB_starter', emailToken: 'tok_starter' }),
    );
    await post('/billing/downgrade', { plan: 'STARTER', confirm: true });

    mocks.fetchSubscription.mockImplementation(async (code: string) =>
      code === 'SUB_starter'
        ? activeSubscription({ subscriptionCode: 'SUB_starter', emailToken: 'tok_starter' })
        : activeSubscription(),
    );

    const { body } = await post('/billing/resume');

    // Both would otherwise start charging from the same date.
    expect(body.data.resumed).toBe(true);
    expect(mocks.disableSubscription).toHaveBeenCalledWith('SUB_starter', 'tok_starter');
  });

  it('leaves everything untouched when the queued change cannot be removed', async () => {
    mocks.createSubscription.mockResolvedValue(
      activeSubscription({ subscriptionCode: 'SUB_starter', emailToken: 'tok_starter' }),
    );
    await post('/billing/downgrade', { plan: 'STARTER', confirm: true });

    mocks.disableSubscription.mockResolvedValue(false);

    const { status } = await post('/billing/resume');

    expect(status).toBe(502);
    expect(mocks.enableSubscription).not.toHaveBeenCalled();
    expect(await readSchedule(BUSINESS_ID)).not.toBeNull();
  });

  it('sends an owner whose plan already lapsed to checkout instead', async () => {
    await post('/billing/pause');

    const stored = redis.json<Record<string, unknown>>(
      `flowdesk:billing:schedule:${BUSINESS_ID}`,
    )!;
    stored.effectiveAt = new Date(Date.now() - 1000).toISOString();
    redis.store.set(`flowdesk:billing:schedule:${BUSINESS_ID}`, JSON.stringify(stored));

    const { body } = await post('/billing/resume');

    expect(body.data.resumed).toBe(false);
    expect(body.data.requiresCheckout).toBe(true);
    expect(body.data.plan).toBe('GROWTH');
  });

  it('says there is nothing to resume when no change is queued', async () => {
    const { body } = await post('/billing/resume');

    expect(body.data.resumed).toBe(false);
    expect(mocks.enableSubscription).not.toHaveBeenCalled();
  });
});

describe('POST /billing/checkout', () => {
  it('sends a cheaper tier to the downgrade endpoint instead of charging for it', async () => {
    const { status, body } = await post('/billing/checkout', { plan: 'BUSINESS' });

    expect(status).toBe(409);
    expect(body.code).toBe('PLAN_DOWNGRADE_REQUIRED');
    expect(mocks.initializeTransaction).not.toHaveBeenCalled();
  });

  it('states the money terms an upgrade actually carries', async () => {
    businessContext = business({ plan: 'STARTER', paystackSubCode: SUB_CODE });

    const { body } = await post('/billing/checkout', { plan: 'GROWTH' });

    expect(body.data.prorated).toBe(false);
    expect(body.data.immediateChargeMinor).toBe(700_00);
    expect(body.data.replacesSubscription).toBe(true);
    expect(body.data.message).toMatch(/not refunded/i);
  });

  it('records the subscription being replaced so the webhook can retire it', async () => {
    businessContext = business({ plan: 'STARTER' });

    await post('/billing/checkout', { plan: 'GROWTH' });

    expect(redis.json<Record<string, unknown>>('flowdesk:paystack:pending:ref_1')).toMatchObject({
      businessId: BUSINESS_ID,
      plan: 'GROWTH',
      expectedAmount: 700_00,
      previousSubscriptionCode: SUB_CODE,
    });
  });

  it('subscribes rather than taking a one-off payment when a plan code is configured', async () => {
    businessContext = business({ plan: 'STARTER', paystackSubCode: null });

    await post('/billing/checkout', { plan: 'GROWTH' });

    // Without this the charge is a single payment, Paystack creates no
    // subscription, and the customer reads as a lapsed trial 48 hours later.
    expect(mocks.initializeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'PLN_growth', amount: 700_00 }),
    );
  });

  it('still takes the payment when no plan code is configured', async () => {
    businessContext = business({ plan: 'STARTER', paystackSubCode: null });
    delete process.env.PAYSTACK_PLAN_GROWTH;

    const { status } = await post('/billing/checkout', { plan: 'GROWTH' });

    expect(status).toBe(200);
    expect(mocks.initializeTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ plan: expect.anything() }),
    );
  });
});
