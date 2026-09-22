import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Telling a stranger they are talking to a machine.
 *
 * `disclosure.ts` exists because Meta's business-messaging policy and Ghana's
 * Data Protection Act both expect it, and because an autonomous assistant that
 * quotes a delivery charge nobody set should not be mistaken for the owner.
 *
 * It was wired into exactly one place: the free-text reply branch. But
 * `settlePendingOrder` returns before that branch whenever an order settles —
 * so the single most consequential unsupervised interaction in the product, an
 * AI confirming an order and asking a stranger for money under the shop's
 * verified WhatsApp identity, was the one case where nobody was told.
 *
 * The order confirmation itself is a Meta-approved template and cannot carry
 * appended text, so the payment request is where the line has to go.
 */

const mocks = vi.hoisted(() => ({
  orderFindFirst: vi.fn(),
  createPaymentLink: vi.fn(),
  autonomyDisclosureFor: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: { order: { findFirst: mocks.orderFindFirst } },
}));

vi.mock('../src/modules/payments/payment-links.service.js', () => ({
  createPaymentLink: mocks.createPaymentLink,
}));

vi.mock('../src/services/assistant/disclosure.js', () => ({
  autonomyDisclosureFor: mocks.autonomyDisclosureFor,
}));

const { requestPaymentForOrder } = await import('../src/services/assistant/autonomous-checkout.js');

const BUSINESS_ID = 'biz_1';
const CUSTOMER_ID = 'cus_1';
const ORDER_ID = 'ord_1';
const DISCLOSURE =
  "— Replies here are automated and can be wrong; we'll confirm anything important.";

/** The text `createPaymentLink` was asked to send. */
function sentMessage(): string {
  const [, input] = mocks.createPaymentLink.mock.calls[0] ?? [];
  return (input as { message?: string } | undefined)?.message ?? '';
}

beforeEach(() => {
  mocks.orderFindFirst.mockReset().mockResolvedValue({
    totalAmount: 40,
    amountPaid: 0,
    referenceNumber: 'ORD-1042',
  });
  mocks.createPaymentLink.mockReset().mockResolvedValue({ reference: 'fdpay-abc' });
  mocks.autonomyDisclosureFor.mockReset().mockResolvedValue(DISCLOSURE);
});

describe('an autonomous payment request', () => {
  it('tells the customer the replies are automated', async () => {
    await requestPaymentForOrder(BUSINESS_ID, CUSTOMER_ID, ORDER_ID);

    expect(mocks.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(sentMessage()).toContain(DISCLOSURE);
  });

  it('still asks for the right amount', async () => {
    await requestPaymentForOrder(BUSINESS_ID, CUSTOMER_ID, ORDER_ID);

    // The disclosure is appended, not substituted — the customer must still be
    // told what they are paying and for which order.
    expect(sentMessage()).toContain('ORD-1042');
    expect(sentMessage()).toContain('40.00');
  });

  it('does not repeat itself once the customer has already been told', async () => {
    // `autonomyDisclosureFor` returns null when it has been said inside the
    // repeat window. A shop that appends it to every message looks like it does
    // not trust its own replies, and the owner turns the assistant off.
    mocks.autonomyDisclosureFor.mockResolvedValue(null);

    await requestPaymentForOrder(BUSINESS_ID, CUSTOMER_ID, ORDER_ID);

    expect(sentMessage()).not.toContain(DISCLOSURE);
    expect(sentMessage()).toContain('ORD-1042');
  });

  it('asks the disclosure about this customer, not just this shop', async () => {
    await requestPaymentForOrder(BUSINESS_ID, CUSTOMER_ID, ORDER_ID);

    // Autonomous mode is implied by reaching here at all — this path is only
    // called in AUTONOMOUS — but the customer id decides whether they have
    // personally been told before.
    expect(mocks.autonomyDisclosureFor).toHaveBeenCalledWith('AUTONOMOUS', BUSINESS_ID, CUSTOMER_ID);
  });

  it('still sends the link if the disclosure check fails', async () => {
    // A missing disclosure is a gap; a payment link that never goes out is a
    // sale the shop loses. The order already exists by this point.
    mocks.autonomyDisclosureFor.mockRejectedValue(new Error('db down'));

    await requestPaymentForOrder(BUSINESS_ID, CUSTOMER_ID, ORDER_ID);

    expect(mocks.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(sentMessage()).toContain('ORD-1042');
  });
});
