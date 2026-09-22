import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RawBodyPluginOptions } from 'fastify-raw-body';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingFakeRedis } from './billing-fake-redis.js';

/**
 * What the Paystack webhook does to a business's plan.
 *
 * The handler used to write `suspendedAt = now()` the moment a subscription
 * ended, which turned an expired card into an immediate, unannounced shutdown
 * of a working shop — and applied the same treatment to a cancellation the
 * owner had asked for. These tests cover the two halves of that: a failure gets
 * the PRD's 3-day grace, and an ending we asked for is not a failure at all.
 *
 * The signature check, the raw-byte hashing and the pending-transaction
 * correlation are all exercised as they really run: the plugin is mounted on a
 * real Fastify instance with the raw-body plugin, and every request is signed.
 */

const redis = new BillingFakeRedis();

const mocks = vi.hoisted(() => ({
  businessFindFirst: vi.fn(),
  businessUpdate: vi.fn(),
  fetchSubscription: vi.fn(),
  disableSubscription: vi.fn(),
}));

vi.mock('../src/config/redis.js', () => ({ redis }));
vi.mock('../src/config/database.js', () => ({
  prisma: { business: { findFirst: mocks.businessFindFirst, update: mocks.businessUpdate } },
}));

// Signature verification is the trust boundary under test, so it stays real.
// Only the outbound calls are replaced.
vi.mock('../src/services/billing/paystack.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/billing/paystack.js')>(
    '../src/services/billing/paystack.js',
  );

  return {
    ...actual,
    fetchSubscription: mocks.fetchSubscription,
    disableSubscription: mocks.disableSubscription,
  };
});

const billingRoutes = (await import('../src/modules/billing/billing.route.js')).default;
const { readSchedule } = await import('../src/services/billing/plan-schedule.js');

const SECRET = 'sk_test_dummy';
const BUSINESS_ID = 'biz_1';
const SUB_CODE = 'SUB_live';
const SCHEDULE_KEY = `flowdesk:billing:schedule:${BUSINESS_ID}`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(import('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  } as RawBodyPluginOptions);
  await app.register(billingRoutes);
  return app;
}

async function deliver(app: FastifyInstance, event: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ event, data });

  return app.inject({
    method: 'POST',
    url: '/webhooks/paystack',
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': crypto.createHmac('sha512', SECRET).update(payload).digest('hex'),
    },
    payload,
  });
}

/** The `data` block of a subscription lifecycle event. */
function subscriptionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Math.floor(Math.random() * 1e9),
    reference: `ref_${Math.random().toString(36).slice(2)}`,
    status: 'success',
    amount: 350_00,
    customer: { email: 'ama@example.com', customer_code: 'CUS_1' },
    subscription_code: SUB_CODE,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  redis.store.clear();
  redis.failing = false;
  mocks.businessUpdate.mockReset().mockResolvedValue({});
  mocks.businessFindFirst.mockReset().mockResolvedValue({ id: BUSINESS_ID, plan: 'BUSINESS' });
  mocks.fetchSubscription.mockReset().mockResolvedValue(null);
  mocks.disableSubscription.mockReset().mockResolvedValue(true);
  app = await buildApp();
});

describe('a subscription ending because the payment failed', () => {
  it('starts a 3-day grace instead of suspending the shop today', async () => {
    const response = await deliver(app, 'subscription.disable', subscriptionEvent());

    expect(response.statusCode).toBe(200);
    expect(mocks.businessUpdate).not.toHaveBeenCalled();

    const schedule = await readSchedule(BUSINESS_ID);
    expect(schedule).toMatchObject({ kind: 'payment_failed', targetPlan: 'SUSPENDED' });
    expect(new Date(schedule!.effectiveAt).getTime()).toBeGreaterThan(
      Date.now() + 2.5 * 24 * 60 * 60 * 1000,
    );
  });

  it('starts the same grace from the earlier invoice failure', async () => {
    await deliver(
      app,
      'invoice.payment_failed',
      subscriptionEvent({ subscription: { subscription_code: SUB_CODE, status: 'attention' } }),
    );

    expect((await readSchedule(BUSINESS_ID))?.kind).toBe('payment_failed');
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it('does not restart the clock when the disable follows the invoice failure', async () => {
    await deliver(app, 'invoice.payment_failed', subscriptionEvent());
    const first = (await readSchedule(BUSINESS_ID))!.effectiveAt;

    await deliver(app, 'subscription.not_renew', subscriptionEvent());
    await deliver(app, 'subscription.disable', subscriptionEvent());

    expect((await readSchedule(BUSINESS_ID))?.effectiveAt).toBe(first);
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it('calls the grace off when the renewal finally goes through', async () => {
    await deliver(app, 'invoice.payment_failed', subscriptionEvent());
    expect(await readSchedule(BUSINESS_ID)).not.toBeNull();

    // A renewal has no pending checkout behind it, so it moves no plan — but it
    // does mean the money arrived, which is the one thing the grace was waiting
    // for.
    await deliver(app, 'charge.success', subscriptionEvent());

    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });

  it('changes nothing for a subscription code it cannot attribute', async () => {
    mocks.businessFindFirst.mockResolvedValue(null);

    await deliver(app, 'subscription.disable', subscriptionEvent());

    expect(mocks.businessUpdate).not.toHaveBeenCalled();
    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });

  it('changes nothing for an event with no subscription code at all', async () => {
    await deliver(app, 'subscription.disable', subscriptionEvent({ subscription_code: undefined }));

    expect(mocks.businessFindFirst).not.toHaveBeenCalled();
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });
});

describe('a subscription ending because the owner asked it to', () => {
  it('does not treat a scheduled cancellation as a failed payment', async () => {
    redis.store.set(
      SCHEDULE_KEY,
      JSON.stringify({
        businessId: BUSINESS_ID,
        kind: 'cancel',
        targetPlan: 'SUSPENDED',
        effectiveAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        previousPlan: 'BUSINESS',
        subscriptionCode: SUB_CODE,
        replacementSubscriptionCode: null,
        requiresCheckout: true,
        appliedAt: null,
      }),
    );

    // Paystack fires `not_renew` the instant we disable the subscription, so
    // this delivery routinely arrives days before the plan should end.
    await deliver(app, 'subscription.not_renew', subscriptionEvent());

    expect((await readSchedule(BUSINESS_ID))?.kind).toBe('cancel');
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it('writes the change through when the paid period has actually ended', async () => {
    redis.store.set(
      SCHEDULE_KEY,
      JSON.stringify({
        businessId: BUSINESS_ID,
        kind: 'downgrade',
        targetPlan: 'STARTER',
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
        previousPlan: 'GROWTH',
        subscriptionCode: SUB_CODE,
        replacementSubscriptionCode: 'SUB_cheaper',
        requiresCheckout: false,
        appliedAt: null,
      }),
    );

    await deliver(app, 'subscription.disable', subscriptionEvent());

    expect(mocks.businessUpdate).toHaveBeenCalledWith({
      where: { id: BUSINESS_ID },
      data: { plan: 'STARTER', paystackSubCode: 'SUB_cheaper', suspendReason: null },
    });
  });
});

describe('a successful checkout', () => {
  function pending(overrides: Record<string, unknown> = {}): void {
    redis.store.set(
      'flowdesk:paystack:pending:ref_checkout',
      JSON.stringify({
        reference: 'ref_checkout',
        businessId: BUSINESS_ID,
        plan: 'GROWTH',
        expectedAmount: 700_00,
        ...overrides,
      }),
    );
  }

  it('moves the plan and records the subscription', async () => {
    pending();

    await deliver(
      app,
      'charge.success',
      subscriptionEvent({
        reference: 'ref_checkout',
        amount: 700_00,
        subscription_code: 'SUB_growth',
      }),
    );

    expect(mocks.businessUpdate).toHaveBeenCalledWith({
      where: { id: BUSINESS_ID },
      data: {
        plan: 'GROWTH',
        suspendedAt: null,
        suspendReason: null,
        paystackSubCode: 'SUB_growth',
      },
    });
  });

  it('cancels a queued downgrade, because paying supersedes it', async () => {
    pending();
    redis.store.set(
      SCHEDULE_KEY,
      JSON.stringify({
        businessId: BUSINESS_ID,
        kind: 'downgrade',
        targetPlan: 'STARTER',
        effectiveAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        previousPlan: 'BUSINESS',
        subscriptionCode: SUB_CODE,
        replacementSubscriptionCode: null,
        requiresCheckout: true,
        appliedAt: null,
      }),
    );

    await deliver(
      app,
      'charge.success',
      subscriptionEvent({ reference: 'ref_checkout', amount: 700_00 }),
    );

    // Leaving it would drop the customer to Starter days after they paid for
    // Growth.
    expect(await readSchedule(BUSINESS_ID)).toBeNull();
  });

  it('stops the subscription the upgrade replaced, but only once the money settled', async () => {
    pending({ previousSubscriptionCode: 'SUB_old' });
    mocks.fetchSubscription.mockResolvedValue({
      subscriptionCode: 'SUB_old',
      emailToken: 'tok_old',
      status: 'active',
      nextPaymentDate: null,
      planCode: null,
      amountMinor: 350_00,
      customerCode: 'CUS_1',
      authorizationCode: null,
    });

    await deliver(
      app,
      'charge.success',
      subscriptionEvent({
        reference: 'ref_checkout',
        amount: 700_00,
        subscription_code: 'SUB_growth',
      }),
    );

    expect(mocks.disableSubscription).toHaveBeenCalledWith('SUB_old', 'tok_old');
  });

  it('applies a replayed delivery exactly once', async () => {
    pending();
    const data = subscriptionEvent({ reference: 'ref_checkout', amount: 700_00, id: 4242 });

    await deliver(app, 'charge.success', data);
    await deliver(app, 'charge.success', data);

    expect(mocks.businessUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses a charge for less than the price recorded at checkout', async () => {
    pending();

    await deliver(
      app,
      'charge.success',
      subscriptionEvent({ reference: 'ref_checkout', amount: 100 }),
    );

    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it('refuses when the event names a different business than the checkout did', async () => {
    pending();

    await deliver(
      app,
      'charge.success',
      subscriptionEvent({
        reference: 'ref_checkout',
        amount: 700_00,
        metadata: { businessId: 'biz_someone_else' },
      }),
    );

    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it('rejects a delivery whose signature does not match the bytes', async () => {
    pending();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': 'a'.repeat(128),
      },
      payload: JSON.stringify({ event: 'charge.success', data: subscriptionEvent() }),
    });

    expect(response.statusCode).toBe(401);
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });
});
