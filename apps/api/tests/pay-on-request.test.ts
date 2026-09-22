import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Alright so how do I pay?"
 *
 * Recorded from a real conversation, in order:
 *
 *   customer  Alright so how do I pay?
 *   shop      You can pay via MTN MoMo, Telecel Cash, AirtelTigo Money, or cash.
 *             Which one works for you?
 *   customer  Im paying with Momo, can I get your momo number??
 *   shop      I can't share the number here, but the payment link will be sent
 *             to you to make it easy.
 *   customer  Alright sure
 *   shop      Okay, just wait for the link to pop up here in the chat.
 *
 * No link was ever sent, because nothing in the pipeline turns "I want to pay"
 * into a payment request. `requestPaymentForOrder` runs only from
 * `settlePendingOrder`, at the moment an order is CREATED. A customer asking to
 * pay for an order that already exists could talk about payment methods
 * forever and never be charged — and the assistant, having no idea, promised a
 * link it had no way to raise.
 *
 * A promise the system cannot keep is worse than a refusal.
 */

const mocks = vi.hoisted(() => ({
  orderFindFirst: vi.fn(),
  createPaymentLink: vi.fn(),
  findOpenRequestForOrder: vi.fn(),
  autonomyDisclosureFor: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: { order: { findFirst: mocks.orderFindFirst } },
}));
vi.mock('../src/modules/payments/payment-links.service.js', () => ({
  createPaymentLink: mocks.createPaymentLink,
}));
vi.mock('../src/modules/payments/payment-links.repository.js', () => ({
  findOpenRequestForOrder: mocks.findOpenRequestForOrder,
}));
vi.mock('../src/services/assistant/disclosure.js', () => ({
  autonomyDisclosureFor: mocks.autonomyDisclosureFor,
}));

const { requestPaymentForOpenOrder } = await import(
  '../src/services/assistant/autonomous-checkout.js'
);

const BUSINESS_ID = 'biz_1';
const CUSTOMER_ID = 'cus_1';

const UNPAID_ORDER = {
  id: 'ord_1',
  referenceNumber: 'FD-00042',
  totalAmount: 120,
  amountPaid: 0,
};

beforeEach(() => {
  mocks.orderFindFirst.mockReset().mockResolvedValue(UNPAID_ORDER);
  mocks.createPaymentLink.mockReset().mockResolvedValue({ reference: 'fdpay-abc' });
  mocks.findOpenRequestForOrder.mockReset().mockResolvedValue(null);
  mocks.autonomyDisclosureFor.mockReset().mockResolvedValue(null);
});

describe('requestPaymentForOpenOrder', () => {
  it('raises a link for the order the customer already has', async () => {
    const sent = await requestPaymentForOpenOrder(BUSINESS_ID, CUSTOMER_ID);

    expect(sent).toBe(true);
    expect(mocks.createPaymentLink).toHaveBeenCalledTimes(1);
    const [, input] = mocks.createPaymentLink.mock.calls[0]!;
    expect(input).toMatchObject({ customerId: CUSTOMER_ID, orderId: 'ord_1', amount: 120 });
  });

  it('asks only for what is still owed', async () => {
    mocks.orderFindFirst.mockResolvedValue({ ...UNPAID_ORDER, amountPaid: 50 });

    await requestPaymentForOpenOrder(BUSINESS_ID, CUSTOMER_ID);

    const [, input] = mocks.createPaymentLink.mock.calls[0]!;
    expect((input as { amount: number }).amount).toBe(70);
  });

  it('does not raise a second link when one is already open', async () => {
    // A customer asking twice must not produce two links for one order — they
    // would pay one and the shop would chase the other.
    mocks.findOpenRequestForOrder.mockResolvedValue({ reference: 'fdpay-existing' });

    const sent = await requestPaymentForOpenOrder(BUSINESS_ID, CUSTOMER_ID);

    expect(sent).toBe(true);
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
  });

  it('reports no link when the customer has no unpaid order', async () => {
    // The caller must then say something true rather than promise a link.
    mocks.orderFindFirst.mockResolvedValue(null);

    const sent = await requestPaymentForOpenOrder(BUSINESS_ID, CUSTOMER_ID);

    expect(sent).toBe(false);
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
  });

  it('reports no link when the order is already settled', async () => {
    mocks.orderFindFirst.mockResolvedValue({ ...UNPAID_ORDER, amountPaid: 120 });

    const sent = await requestPaymentForOpenOrder(BUSINESS_ID, CUSTOMER_ID);

    expect(sent).toBe(false);
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing when payouts are not connected', async () => {
    // The commonest real cause. The order stands and the shop collects some
    // other way. What must not happen is an unhandled rejection in the worker.
    mocks.createPaymentLink.mockRejectedValue(new Error('payouts not connected'));

    const sent = await requestPaymentForOpenOrder(BUSINESS_ID, CUSTOMER_ID);

    expect(sent).toBe(false);
  });
});
