import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Finding 1 regression test: a refund (direction OUT) must never trigger the
 * customer-facing "payment received" notice or the confirmed SSE event, even
 * once attested/logged as attested. Only direction IN may notify the customer.
 *
 * This suite is otherwise DB-free, so every Prisma-backed dependency of
 * payments.service.ts is mocked at the module boundary via vi.mock — the
 * service's own logic (the direction/confidence gating) is what's under test,
 * not the repositories or the notification pipeline themselves.
 */

const mocks = vi.hoisted(() => ({
  notifyPaymentReceived: vi.fn().mockResolvedValue(undefined),
  emitPaymentConfirmed: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
  findCustomerById: vi.fn(),
  findOrderById: vi.fn(),
  createPayment: vi.fn(),
  findPaymentById: vi.fn(),
  attestPaymentWithSideEffects: vi.fn(),
}));

vi.mock('../src/services/notifications/customer-notifications.js', () => ({
  notifyPaymentReceived: mocks.notifyPaymentReceived,
}));

vi.mock('../src/services/sse/sse.events.js', () => ({
  emitPaymentConfirmed: mocks.emitPaymentConfirmed,
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
  createPayment: mocks.createPayment,
  findPaymentById: mocks.findPaymentById,
  attestPaymentWithSideEffects: mocks.attestPaymentWithSideEffects,
}));

const { logPayment, attestPayment } = await import('../src/modules/payments/payments.service.js');

const CUSTOMER = { id: 'cust_1', name: 'Ama', waNumber: '233209998877' };

function paymentRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'pay_1',
    amount: 100,
    method: 'MOMO_MTN',
    direction: 'IN',
    confidence: 'SELLER_ATTESTED',
    reference: null,
    attestedAt: new Date(),
    voidedAt: null,
    voidReason: null,
    screenshotUrl: null,
    customer: CUSTOMER,
    orderId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notifyPaymentReceived.mockResolvedValue(undefined);
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.findCustomerById.mockResolvedValue(CUSTOMER);
});

describe('logPayment notification gating (Finding 1)', () => {
  it('does NOT notify the customer for an attested OUT payment (a refund)', async () => {
    mocks.createPayment.mockResolvedValue(paymentRow({ direction: 'OUT', confidence: 'SELLER_ATTESTED' }));

    await logPayment(
      {
        customerId: CUSTOMER.id,
        amount: 100,
        method: 'MOMO_MTN',
        direction: 'OUT',
        attested: true,
      } as never,
      'biz_1',
      null,
    );

    expect(mocks.notifyPaymentReceived).not.toHaveBeenCalled();
    expect(mocks.emitPaymentConfirmed).not.toHaveBeenCalled();
    // The internal audit trail must still record the refund.
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.refunded' }),
    );
  });

  it('DOES notify the customer for an attested IN payment (a normal receipt)', async () => {
    mocks.createPayment.mockResolvedValue(paymentRow({ direction: 'IN', confidence: 'SELLER_ATTESTED' }));

    await logPayment(
      {
        customerId: CUSTOMER.id,
        amount: 100,
        method: 'MOMO_MTN',
        direction: 'IN',
        attested: true,
      } as never,
      'biz_1',
      null,
    );

    expect(mocks.notifyPaymentReceived).toHaveBeenCalledTimes(1);
    expect(mocks.notifyPaymentReceived).toHaveBeenCalledWith('pay_1');
    expect(mocks.emitPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.logged' }),
    );
  });

  it('does not notify at all for an unattested CLAIMED payment, of either direction', async () => {
    mocks.createPayment.mockResolvedValue(paymentRow({ direction: 'IN', confidence: 'CLAIMED' }));

    await logPayment(
      {
        customerId: CUSTOMER.id,
        amount: 100,
        method: 'MOMO_MTN',
        direction: 'IN',
        attested: false,
      } as never,
      'biz_1',
      null,
    );

    expect(mocks.notifyPaymentReceived).not.toHaveBeenCalled();
    expect(mocks.emitPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});

describe('attestPayment notification gating (Finding 1)', () => {
  it('does NOT notify the customer when attesting an OUT payment (a refund)', async () => {
    mocks.findPaymentById.mockResolvedValue(paymentRow({ direction: 'OUT', confidence: 'CLAIMED' }));
    mocks.attestPaymentWithSideEffects.mockResolvedValue(
      paymentRow({ direction: 'OUT', confidence: 'SELLER_ATTESTED' }),
    );

    await attestPayment('pay_1', 'biz_1', 'staff_1');

    expect(mocks.notifyPaymentReceived).not.toHaveBeenCalled();
    expect(mocks.emitPaymentConfirmed).not.toHaveBeenCalled();
    // Attestation itself is still audited regardless of direction.
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
  });

  it('DOES notify the customer when attesting an IN payment', async () => {
    mocks.findPaymentById.mockResolvedValue(paymentRow({ direction: 'IN', confidence: 'CLAIMED' }));
    mocks.attestPaymentWithSideEffects.mockResolvedValue(
      paymentRow({ direction: 'IN', confidence: 'SELLER_ATTESTED' }),
    );

    await attestPayment('pay_1', 'biz_1', 'staff_1');

    expect(mocks.notifyPaymentReceived).toHaveBeenCalledTimes(1);
    expect(mocks.notifyPaymentReceived).toHaveBeenCalledWith('pay_1');
    expect(mocks.emitPaymentConfirmed).toHaveBeenCalledTimes(1);
  });
});
