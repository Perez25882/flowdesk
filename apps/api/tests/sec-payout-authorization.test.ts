import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may change where a shop's money lands.
 *
 * `PUT /payouts` repoints the Paystack subaccount's settlement bank and account
 * number in place, so it decides where every future customer payment for this
 * shop arrives. It was originally gated on `settings.write`, which MANAGER
 * holds — meaning one phished day-to-day staff login could redirect the shop's
 * entire takings to an attacker's momo number, with no owner confirmation and
 * no notification. The route's own comment said "the owner's business, not a
 * staff matter"; the capability it picked did not implement that.
 *
 * Reading the destination back is owner-only for the same reason: it carries
 * the account number and the resolved account-holder name.
 */

const mocks = vi.hoisted(() => ({
  connectPayout: vi.fn(),
  getPayoutStatus: vi.fn(),
  listDestinations: vi.fn(),
}));

vi.mock('../src/modules/payments/payouts.service.js', () => ({
  connectPayout: mocks.connectPayout,
  getPayoutStatus: mocks.getPayoutStatus,
  listDestinations: mocks.listDestinations,
}));

vi.mock('../src/modules/payments/payments.service.js', () => ({}));
vi.mock('../src/modules/payments/payment-links.service.js', () => ({}));

const paymentRoutes = (await import('../src/modules/payments/payments.route.js')).default;

const BUSINESS_ID = 'biz_1';

type Caller = { staffId?: string; role?: string };

/** The owner has no staff id; staff carry one plus a role. */
const OWNER: Caller = {};
const MANAGER: Caller = { staffId: 'staff_mgr', role: 'MANAGER' };
const OPERATIONS: Caller = { staffId: 'staff_ops', role: 'OPERATIONS' };

async function buildApp(caller: Caller): Promise<FastifyInstance> {
  const app = Fastify();

  // Stands in for `requireAuth` + `attachBusinessContext`, which the real app
  // applies to the authenticated sub-app these routes are mounted in.
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.user = { businessId: BUSINESS_ID, plan: 'GROWTH', ...caller } as FastifyRequest['user'];
    request.business = { id: BUSINESS_ID } as FastifyRequest['business'];
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: error.message });
  });

  await app.register(paymentRoutes);
  return app;
}

const VALID_PAYOUT = { bankCode: 'MTN', accountNumber: '0241234567' };

beforeEach(() => {
  mocks.connectPayout.mockReset().mockResolvedValue({ connected: true });
  mocks.getPayoutStatus.mockReset().mockResolvedValue({ connected: false });
  mocks.listDestinations.mockReset().mockResolvedValue([]);
});

describe('PUT /payouts', () => {
  it('refuses a manager, who must not be able to redirect the shop takings', async () => {
    const app = await buildApp(MANAGER);

    const response = await app.inject({
      method: 'PUT',
      url: '/payouts',
      payload: VALID_PAYOUT,
    });

    expect(response.statusCode).toBe(403);
    // The refusal must happen before Paystack is touched: `updateSubaccount`
    // mutates the live subaccount in place, so reaching the service at all
    // would already have moved the money.
    expect(mocks.connectPayout).not.toHaveBeenCalled();
  });

  it('refuses counter staff', async () => {
    const app = await buildApp(OPERATIONS);

    const response = await app.inject({
      method: 'PUT',
      url: '/payouts',
      payload: VALID_PAYOUT,
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.connectPayout).not.toHaveBeenCalled();
  });

  it('allows the owner', async () => {
    const app = await buildApp(OWNER);

    const response = await app.inject({
      method: 'PUT',
      url: '/payouts',
      payload: VALID_PAYOUT,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.connectPayout).toHaveBeenCalledWith(BUSINESS_ID, VALID_PAYOUT);
  });
});

describe('GET /payouts', () => {
  it('refuses a manager, who must not read back the account number', async () => {
    const app = await buildApp(MANAGER);

    const response = await app.inject({ method: 'GET', url: '/payouts' });

    expect(response.statusCode).toBe(403);
    expect(mocks.getPayoutStatus).not.toHaveBeenCalled();
  });

  it('allows the owner', async () => {
    const app = await buildApp(OWNER);

    const response = await app.inject({ method: 'GET', url: '/payouts' });

    expect(response.statusCode).toBe(200);
    expect(mocks.getPayoutStatus).toHaveBeenCalledWith(BUSINESS_ID);
  });
});
