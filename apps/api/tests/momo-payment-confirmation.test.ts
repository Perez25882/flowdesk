import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Turning a flagged screenshot into money.
 *
 * The claim a screenshot produces carries no amount, so confirming it is where
 * the figure is first stated — and where every guard that protects the money
 * table has to hold: one confirmation per claim however many times the button
 * is tapped, no receipt for a refund, and no attesting a placeholder.
 *
 * DB-free, in the style of `payment-notifications.test.ts`: every Prisma-backed
 * dependency is mocked at the module boundary.
 */

const mocks = vi.hoisted(() => ({
  notifyPaymentReceived: vi.fn().mockResolvedValue(undefined),
  notifyOwnerPaymentRecorded: vi.fn().mockResolvedValue(undefined),
  emitPaymentConfirmed: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
  findOrderById: vi.fn(),
  findCustomerById: vi.fn(),
  findPaymentById: vi.fn(),
  attestPaymentWithSideEffects: vi.fn(),
  confirmClaimWithSideEffects: vi.fn(),
  voidPayment: vi.fn(),
  clearScreenshotReviewFlag: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/notifications/customer-notifications.js', () => ({
  notifyPaymentReceived: mocks.notifyPaymentReceived,
}));

vi.mock('../src/services/notifications/owner-notifications.js', () => ({
  notifyOwnerPaymentRecorded: mocks.notifyOwnerPaymentRecorded,
}));

vi.mock('../src/services/sse/sse.events.js', () => ({
  emitPaymentConfirmed: mocks.emitPaymentConfirmed,
}));

vi.mock('../src/services/s3/media.js', () => ({
  getArchivedMedia: vi.fn(),
}));

vi.mock('../src/modules/staff/staff-activity.repository.js', () => ({
  logActivity: mocks.logActivity,
}));

vi.mock('../src/modules/customers/customers.repository.js', () => ({
  findCustomerById: mocks.findCustomerById,
}));

vi.mock('../src/modules/orders/orders.repository.js', () => ({
  findOrderById: mocks.findOrderById,
}));

vi.mock('../src/modules/payments/payments.repository.js', () => ({
  findPaymentById: mocks.findPaymentById,
  attestPaymentWithSideEffects: mocks.attestPaymentWithSideEffects,
  confirmClaimWithSideEffects: mocks.confirmClaimWithSideEffects,
  voidPayment: mocks.voidPayment,
}));

vi.mock('../src/modules/payments/screenshot-claims.js', () => ({
  clearScreenshotReviewFlag: mocks.clearScreenshotReviewFlag,
}));

const { attestPayment, confirmPayment, voidPayment } = await import(
  '../src/modules/payments/payments.service.js'
);

const CUSTOMER = { id: 'cust_1', name: 'Emmanuel', waNumber: '233209998877' };
const SCREENSHOT_KEY = 'businesses/biz_1/media/wamid_abc.jpeg';

const CONFIRMATION = { amount: 450, method: 'MOMO_MTN' as const };

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay_shot',
    amount: 0,
    method: 'OTHER',
    direction: 'IN',
    confidence: 'CLAIMED',
    reference: null,
    attestedAt: null,
    voidedAt: null,
    voidReason: null,
    screenshotUrl: null,
    screenshotKey: SCREENSHOT_KEY,
    customer: CUSTOMER,
    orderId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notifyPaymentReceived.mockResolvedValue(undefined);
  mocks.notifyOwnerPaymentRecorded.mockResolvedValue(undefined);
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.clearScreenshotReviewFlag.mockResolvedValue(undefined);
});

describe('confirmPayment', () => {
  it('records the amount, receipts the customer and takes the message out of review', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow());
    mocks.confirmClaimWithSideEffects.mockResolvedValue(
      claimRow({ amount: 450, method: 'MOMO_MTN', confidence: 'SELLER_ATTESTED' }),
    );

    await confirmPayment('pay_shot', 'biz_1', CONFIRMATION, 'owner');

    expect(mocks.confirmClaimWithSideEffects).toHaveBeenCalledWith(
      'pay_shot',
      'biz_1',
      CONFIRMATION,
      'owner',
    );
    expect(mocks.emitPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.notifyPaymentReceived).toHaveBeenCalledWith('pay_shot');
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.attested' }),
    );
    expect(mocks.clearScreenshotReviewFlag).toHaveBeenCalledWith('biz_1', SCREENSHOT_KEY);
  });

  it('confirms once when the owner taps twice on a slow connection', async () => {
    // The conditional update in the repository is what makes this true; the
    // service must not paper over the null it returns by notifying anyway.
    mocks.findPaymentById.mockResolvedValue(claimRow());
    mocks.confirmClaimWithSideEffects.mockResolvedValue(null);

    await expect(confirmPayment('pay_shot', 'biz_1', CONFIRMATION, 'owner')).rejects.toThrow(
      /already been attested or voided/,
    );

    expect(mocks.emitPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentReceived).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it('refuses an order belonging to another business before writing anything', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow());
    mocks.findOrderById.mockResolvedValue(null);

    await expect(
      confirmPayment('pay_shot', 'biz_1', { ...CONFIRMATION, orderId: 'ord_other' }, 'owner'),
    ).rejects.toThrow(/Order not found/);

    expect(mocks.confirmClaimWithSideEffects).not.toHaveBeenCalled();
  });

  it('says so plainly when the claim is gone', async () => {
    mocks.findPaymentById.mockResolvedValue(null);

    await expect(confirmPayment('pay_gone', 'biz_1', CONFIRMATION, 'owner')).rejects.toThrow(
      /Payment not found/,
    );
  });

  it('does not tell a customer money arrived when confirming a refund', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow({ direction: 'OUT' }));
    mocks.confirmClaimWithSideEffects.mockResolvedValue(
      claimRow({ direction: 'OUT', amount: 450, confidence: 'SELLER_ATTESTED' }),
    );

    await confirmPayment('pay_shot', 'biz_1', CONFIRMATION, 'owner');

    expect(mocks.notifyPaymentReceived).not.toHaveBeenCalled();
    expect(mocks.emitPaymentConfirmed).not.toHaveBeenCalled();
    // The audit trail records it regardless of direction.
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
  });
});

describe('attestPayment on a claim with no amount', () => {
  it('refuses, rather than writing GHS 0.00 into the customer record', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow());

    await expect(attestPayment('pay_shot', 'biz_1', 'owner')).rejects.toThrow(
      /no amount yet/,
    );

    expect(mocks.attestPaymentWithSideEffects).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentReceived).not.toHaveBeenCalled();
  });

  it('still attests an ordinary claim that already has an amount', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow({ amount: 250, screenshotKey: null }));
    mocks.attestPaymentWithSideEffects.mockResolvedValue(
      claimRow({ amount: 250, screenshotKey: null, confidence: 'SELLER_ATTESTED' }),
    );

    await attestPayment('pay_logged', 'biz_1', 'staff_1');

    expect(mocks.notifyPaymentReceived).toHaveBeenCalledTimes(1);
    expect(mocks.emitPaymentConfirmed).toHaveBeenCalledTimes(1);
  });
});

describe('voidPayment as a dismissal', () => {
  it('takes a dismissed screenshot out of the message review queue too', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow());
    mocks.voidPayment.mockResolvedValue(true);

    await voidPayment('pay_shot', 'biz_1', 'owner', 'Not a payment');

    expect(mocks.clearScreenshotReviewFlag).toHaveBeenCalledWith('biz_1', SCREENSHOT_KEY);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.voided' }),
    );
  });

  it('is a no-op the second time, and does not clear anything again', async () => {
    mocks.findPaymentById.mockResolvedValue(claimRow({ voidedAt: new Date() }));
    mocks.voidPayment.mockResolvedValue(false);

    await expect(voidPayment('pay_shot', 'biz_1', 'owner', 'Not a payment')).rejects.toThrow(
      /already voided/,
    );

    expect(mocks.clearScreenshotReviewFlag).not.toHaveBeenCalled();
  });
});
