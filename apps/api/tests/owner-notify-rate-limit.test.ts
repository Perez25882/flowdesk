import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './owner-notify-fake-redis.js';

/**
 * A shop taking forty orders in an hour must not send its owner forty WhatsApp
 * messages. The cooldown is what stops that, and the coalescing counter is what
 * keeps it honest: an event suppressed inside the cooldown is counted, and the
 * count is reported in the next alert rather than disappearing.
 *
 * These tests drive the owner's own number as if it were inside Meta's 24-hour
 * window, so every alert lands on the outbound queue and the wording is
 * inspectable. The channel choice itself is covered in owner-notify-gating.
 */

const redis = new FakeRedis();

const mocks = vi.hoisted(() => ({
  businessFindUnique: vi.fn(),
  customerFindFirst: vi.fn(),
  orderFindUnique: vi.fn(),
  productFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  canSendOutbound: vi.fn(),
  enqueueOutboundMessage: vi.fn(),
  loadTenantCredentials: vi.fn(),
  sendTemplate: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: {
    business: { findUnique: mocks.businessFindUnique },
    customer: { findFirst: mocks.customerFindFirst },
    order: { findUnique: mocks.orderFindUnique },
    product: { findUnique: mocks.productFindUnique },
    payment: { findUnique: mocks.paymentFindUnique },
  },
}));

vi.mock('../src/config/redis.js', () => ({ redis }));

vi.mock('../src/services/plan/plan.service.js', () => ({
  canSendOutbound: mocks.canSendOutbound,
}));

vi.mock('../src/queues/outbound.queue.js', () => ({
  enqueueOutboundMessage: mocks.enqueueOutboundMessage,
}));

vi.mock('../src/services/whatsapp/client.js', () => ({
  loadTenantCredentials: mocks.loadTenantCredentials,
  sendTemplate: mocks.sendTemplate,
}));

const { notifyOwnerLowStock, notifyOwnerNewOrder } = await import(
  '../src/services/notifications/owner-notifications.js'
);

const BUSINESS_ID = 'biz_1';

/** Body of the nth queued alert, in call order. */
function queuedBody(index: number): string {
  const job = mocks.enqueueOutboundMessage.mock.calls[index]?.[0] as { body: string } | undefined;
  return job?.body ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.store.clear();
  redis.failing = false;

  mocks.businessFindUnique.mockResolvedValue({
    id: BUSINESS_ID,
    name: 'Ama Provisions',
    phone: '0244123456',
    notifyOnNewOrder: true,
    notifyOnLowStock: true,
    notifyOnPayment: true,
  });
  // The owner messaged their own shop number a minute ago, so the free-form
  // path is open and every alert is readable straight off the queue.
  mocks.customerFindFirst.mockResolvedValue({ lastInboundAt: new Date(Date.now() - 60_000) });
  mocks.canSendOutbound.mockResolvedValue(true);
  mocks.enqueueOutboundMessage.mockResolvedValue(undefined);
  mocks.orderFindUnique.mockResolvedValue({
    businessId: BUSINESS_ID,
    referenceNumber: 'FD-01042',
    totalAmount: 250,
    customer: { name: 'Kofi Mensah' },
  });
  mocks.productFindUnique.mockResolvedValue({
    businessId: BUSINESS_ID,
    name: 'Milo 400g',
    unit: 'tin',
    stockQuantity: 2,
    reorderThreshold: 5,
  });
});

describe('cooldown per notification kind', () => {
  it('delivers the first alert immediately', async () => {
    await notifyOwnerNewOrder('order_1');

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(queuedBody(0)).toContain('That makes 1 new order since your last alert.');
  });

  it('sends one message, not forty, for a burst of orders', async () => {
    for (let i = 0; i < 40; i += 1) {
      await notifyOwnerNewOrder(`order_${i}`);
    }

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('reports the suppressed events in the next alert instead of losing them', async () => {
    await notifyOwnerNewOrder('order_1');
    await notifyOwnerNewOrder('order_2');
    await notifyOwnerNewOrder('order_3');

    redis.expireCooldowns();
    await notifyOwnerNewOrder('order_4');

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(2);
    expect(queuedBody(1)).toContain('That makes 3 new orders since your last alert.');
  });

  it('starts the count again once a backlog has been reported', async () => {
    await notifyOwnerNewOrder('order_1');
    await notifyOwnerNewOrder('order_2');

    redis.expireCooldowns();
    await notifyOwnerNewOrder('order_3');

    redis.expireCooldowns();
    await notifyOwnerNewOrder('order_4');

    expect(queuedBody(2)).toContain('That makes 1 new order since your last alert.');
  });

  it('keeps each kind on its own cooldown', async () => {
    await notifyOwnerNewOrder('order_1');
    await notifyOwnerLowStock('prod_1');

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(2);
    expect(queuedBody(0)).toContain('That makes 1 new order since your last alert.');
    expect(queuedBody(1)).toContain('That makes 1 stock alert since your last alert.');
  });

  it('keeps each business on its own cooldown', async () => {
    await notifyOwnerNewOrder('order_1');

    mocks.orderFindUnique.mockResolvedValue({
      businessId: 'biz_2',
      referenceNumber: 'FD-00007',
      totalAmount: 40,
      customer: { name: 'Yaa' },
    });
    mocks.businessFindUnique.mockResolvedValue({
      id: 'biz_2',
      name: 'Kofi Hardware',
      phone: '0209998877',
      notifyOnNewOrder: true,
      notifyOnLowStock: true,
      notifyOnPayment: true,
    });

    await notifyOwnerNewOrder('order_2');

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(2);
  });

  it('pluralises the coalesced count correctly for stock alerts', async () => {
    await notifyOwnerLowStock('prod_1');
    await notifyOwnerLowStock('prod_2');
    await notifyOwnerLowStock('prod_3');

    redis.expireCooldowns();
    await notifyOwnerLowStock('prod_4');

    expect(queuedBody(1)).toContain('That makes 3 stock alerts since your last alert.');
  });
});

describe('when Redis is unavailable', () => {
  it('still delivers the alert rather than staying silent about a new order', async () => {
    redis.failing = true;

    await notifyOwnerNewOrder('order_1');

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(queuedBody(0)).toContain('That makes 1 new order since your last alert.');
  });
});
