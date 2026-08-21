import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './owner-notify-fake-redis.js';

/**
 * The three owner-notification toggles on `Business` were rendered in Settings
 * but read by nothing. These tests pin down what they now do, and — just as
 * important — which channel the message actually leaves on.
 *
 * The owner's own number has almost never messaged the shop's WhatsApp number,
 * so Meta's 24-hour window is shut for them and a free-form send would be
 * rejected as 131047 and dead-lettered. So the channel choice is part of the
 * contract, not an implementation detail: inside the window a text goes on the
 * outbound queue, outside it an approved template goes out directly.
 *
 * DB-free: every Prisma-backed and network-backed dependency is mocked at the
 * module boundary, and Redis is the in-memory fake.
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

const {
  OWNER_TEMPLATES,
  notifyOwnerLowStock,
  notifyOwnerNewOrder,
  notifyOwnerPaymentRecorded,
} = await import('../src/services/notifications/owner-notifications.js');

const BUSINESS_ID = 'biz_1';

function businessRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    name: 'Ama Provisions',
    phone: '0244123456',
    notifyOnNewOrder: true,
    notifyOnLowStock: true,
    notifyOnPayment: true,
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessId: BUSINESS_ID,
    referenceNumber: 'FD-01042',
    totalAmount: 250,
    customer: { name: 'Kofi Mensah' },
    ...overrides,
  };
}

/** The last set of template body parameters handed to Meta. */
function templateParameters(): string[] {
  const call = mocks.sendTemplate.mock.calls.at(-1);
  const components = call?.[4] as Array<{ parameters: Array<{ text: string }> }>;
  return components[0]!.parameters.map((parameter) => parameter.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.store.clear();
  redis.failing = false;

  mocks.businessFindUnique.mockResolvedValue(businessRow());
  // No customer row for the owner's number: the normal case, and the one where
  // the 24-hour window has never opened.
  mocks.customerFindFirst.mockResolvedValue(null);
  mocks.canSendOutbound.mockResolvedValue(true);
  mocks.enqueueOutboundMessage.mockResolvedValue(undefined);
  mocks.loadTenantCredentials.mockResolvedValue({
    businessId: BUSINESS_ID,
    phoneNumberId: 'pn_1',
    accessToken: 'token',
    businessName: 'Ama Provisions',
  });
  mocks.sendTemplate.mockResolvedValue({ waMessageId: 'wamid.1' });
  mocks.orderFindUnique.mockResolvedValue(orderRow());
});

describe('owner preference gating', () => {
  it('sends nothing when notifyOnNewOrder is off', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ notifyOnNewOrder: false }));

    await notifyOwnerNewOrder('order_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('sends nothing when notifyOnLowStock is off', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ notifyOnLowStock: false }));
    mocks.productFindUnique.mockResolvedValue({
      businessId: BUSINESS_ID,
      name: 'Milo 400g',
      unit: 'tin',
      stockQuantity: 2,
      reorderThreshold: 5,
    });

    await notifyOwnerLowStock('prod_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('sends nothing when notifyOnPayment is off', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ notifyOnPayment: false }));
    mocks.paymentFindUnique.mockResolvedValue({
      businessId: BUSINESS_ID,
      amount: 80,
      direction: 'IN',
      customer: { name: 'Kofi Mensah' },
      order: null,
    });

    await notifyOwnerPaymentRecorded('pay_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('one preference being off does not silence the others', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ notifyOnLowStock: false }));

    await notifyOwnerNewOrder('order_1');

    expect(mocks.sendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('owner phone and plan gating', () => {
  it('degrades quietly when the business has no owner phone recorded', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ phone: null }));

    await expect(notifyOwnerNewOrder('order_1')).resolves.toBeUndefined();

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('treats a phone that normalises to nothing as no phone at all', async () => {
    mocks.businessFindUnique.mockResolvedValue(businessRow({ phone: '   ' }));

    await notifyOwnerNewOrder('order_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
  });

  it('sends nothing when the plan allowance is exhausted or the business is suspended', async () => {
    mocks.canSendOutbound.mockResolvedValue(false);

    await notifyOwnerNewOrder('order_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('does not burn a cooldown slot on a message the plan blocked', async () => {
    mocks.canSendOutbound.mockResolvedValue(false);
    await notifyOwnerNewOrder('order_1');

    mocks.canSendOutbound.mockResolvedValue(true);
    await notifyOwnerNewOrder('order_2');

    expect(mocks.sendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('channel selection against Meta’s 24-hour window', () => {
  it('uses an approved template when the owner has never messaged the shop', async () => {
    await notifyOwnerNewOrder('order_1');

    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.sendTemplate).toHaveBeenCalledTimes(1);

    const [, to, name, language] = mocks.sendTemplate.mock.calls[0]!;
    expect(to).toBe('233244123456');
    expect(name).toBe(OWNER_TEMPLATES.new_order.name);
    expect(language).toBe(OWNER_TEMPLATES.new_order.language);
    expect(templateParameters()).toEqual([
      'FD-01042',
      'Ama Provisions',
      'Kofi Mensah',
      '250.00',
      '1 new order',
    ]);
  });

  it('supplies one parameter for every placeholder the template body declares', async () => {
    await notifyOwnerNewOrder('order_1');

    const placeholders = new Set(
      [...OWNER_TEMPLATES.new_order.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => match[1]),
    );
    expect(templateParameters()).toHaveLength(placeholders.size);
  });

  it('queues a free-form text when the owner has messaged the shop within 24 hours', async () => {
    mocks.customerFindFirst.mockResolvedValue({ lastInboundAt: new Date(Date.now() - 60_000) });

    await notifyOwnerNewOrder('order_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);

    const job = mocks.enqueueOutboundMessage.mock.calls[0]![0] as {
      to: string;
      body: string;
      customerId: string | null;
    };
    expect(job.to).toBe('233244123456');
    expect(job.customerId).toBeNull();
    expect(job.body).toContain('FD-01042');
    expect(job.body).toContain('That makes 1 new order since your last alert.');
  });

  it('falls back to the template once that window has closed again', async () => {
    mocks.customerFindFirst.mockResolvedValue({
      lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await notifyOwnerNewOrder('order_1');

    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a template send when the tenant has no usable connection', async () => {
    mocks.loadTenantCredentials.mockResolvedValue(null);

    await expect(notifyOwnerNewOrder('order_1')).resolves.toBeUndefined();

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('a failing notification never breaks its trigger', () => {
  it('swallows a Meta rejection (an unapproved template) and resolves', async () => {
    mocks.sendTemplate.mockRejectedValue(new Error('template does not exist (132001)'));

    await expect(notifyOwnerNewOrder('order_1')).resolves.toBeUndefined();
  });

  it('swallows a database failure while loading the order', async () => {
    mocks.orderFindUnique.mockRejectedValue(new Error('connection terminated'));

    await expect(notifyOwnerNewOrder('order_1')).resolves.toBeUndefined();
    expect(mocks.sendTemplate).not.toHaveBeenCalled();
  });

  it('does nothing when the record has vanished', async () => {
    mocks.orderFindUnique.mockResolvedValue(null);

    await notifyOwnerNewOrder('order_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('per-kind message contents', () => {
  it('reports low stock with the quantity trimmed of Decimal padding', async () => {
    mocks.productFindUnique.mockResolvedValue({
      businessId: BUSINESS_ID,
      name: 'Milo 400g',
      unit: 'tin',
      stockQuantity: 2,
      reorderThreshold: 5.5,
    });

    await notifyOwnerLowStock('prod_1');

    expect(templateParameters()).toEqual([
      'Ama Provisions',
      'Milo 400g',
      '2 tin',
      '5.5 tin',
      '1 stock alert',
    ]);
  });

  it('names the order a payment settles, and says so when there is none', async () => {
    mocks.paymentFindUnique.mockResolvedValue({
      businessId: BUSINESS_ID,
      amount: 80,
      direction: 'IN',
      customer: { name: 'Kofi Mensah' },
      order: { referenceNumber: 'FD-01042' },
    });

    await notifyOwnerPaymentRecorded('pay_1');

    expect(templateParameters()).toEqual([
      '80.00',
      'Ama Provisions',
      'Kofi Mensah',
      'order FD-01042',
      '1 payment',
    ]);
  });

  it('never announces a refund as a payment received', async () => {
    mocks.paymentFindUnique.mockResolvedValue({
      businessId: BUSINESS_ID,
      amount: 80,
      direction: 'OUT',
      customer: { name: 'Kofi Mensah' },
      order: null,
    });

    await notifyOwnerPaymentRecorded('pay_1');

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('falls back to a generic customer label when the customer is unnamed', async () => {
    mocks.orderFindUnique.mockResolvedValue(orderRow({ customer: { name: null } }));

    await notifyOwnerNewOrder('order_1');

    expect(templateParameters()[2]).toBe('a customer');
  });
});
