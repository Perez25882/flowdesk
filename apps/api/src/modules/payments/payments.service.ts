import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { notifyPaymentReceived } from '../../services/notifications/customer-notifications.js';
import { emitPaymentConfirmed } from '../../services/sse/sse.events.js';
import type { CreatePaymentInput, ListPaymentsQueryInput } from './payments.schema.js';
import * as repository from './payments.repository.js';
import { findCustomerById } from '../customers/customers.repository.js';
import { findOrderById } from '../orders/orders.repository.js';
import { logActivity } from '../staff/staff-activity.repository.js';

export async function logPayment(
  data: CreatePaymentInput,
  businessId: string,
  loggedById: string | null,
): Promise<repository.PaymentWithCustomer> {
  // Both lookups are tenant-scoped, so a caller cannot attach a payment to
  // another business's customer or order by guessing an id.
  const customer = await findCustomerById(data.customerId, businessId);
  if (!customer) {
    throw new NotFoundError('Customer not found');
  }

  if (data.orderId) {
    const order = await findOrderById(data.orderId, businessId);
    if (!order) {
      throw new NotFoundError('Order not found');
    }
  }

  const payment = await repository.createPayment(data, businessId, loggedById);

  if (payment.confidence !== 'CLAIMED') {
    emitPaymentConfirmed(businessId, {
      paymentId: payment.id,
      orderId: payment.orderId ?? '',
      amount: Number(payment.amount),
    });

    await notifyPaymentReceived(payment.id);

    await logActivity({
      staffId: loggedById ?? 'owner',
      action: payment.direction === 'OUT' ? 'payment.refunded' : 'payment.logged',
      resourceId: payment.id,
      resourceType: 'payment',
      note: `${payment.direction === 'OUT' ? 'Refund' : 'Payment'} of GHS ${Number(payment.amount).toFixed(2)} logged`,
    }).catch(() => {});
  }

  return payment;
}

export async function attestPayment(
  paymentId: string,
  businessId: string,
  attestedBy: string,
): Promise<repository.PaymentWithCustomer> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }

  const attested = await repository.attestPaymentWithSideEffects(paymentId, businessId, attestedBy);
  if (!attested) {
    // The conditional claim did not land: someone else attested it, or it was
    // voided between the read and the write.
    throw new ValidationError('Payment has already been attested or voided');
  }

  emitPaymentConfirmed(businessId, {
    paymentId: attested.id,
    orderId: attested.orderId ?? '',
    amount: Number(attested.amount),
  });

  await logActivity({
    staffId: attestedBy,
    action: 'payment.attested',
    resourceId: paymentId,
    resourceType: 'payment',
    note: `Payment of GHS ${Number(attested.amount).toFixed(2)} attested as received`,
  }).catch(() => {});

  await notifyPaymentReceived(attested.id);

  return attested;
}

export async function voidPayment(
  paymentId: string,
  businessId: string,
  voidedBy: string,
  reason: string,
): Promise<void> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }

  const didVoid = await repository.voidPayment(paymentId, businessId, voidedBy, reason);
  if (!didVoid) {
    throw new ValidationError('Payment is already voided');
  }

  await logActivity({
    staffId: voidedBy,
    action: 'payment.voided',
    resourceId: paymentId,
    resourceType: 'payment',
    note: `Payment of GHS ${Number(payment.amount).toFixed(2)} voided: ${reason}`,
  }).catch(() => {});
}

export async function listPayments(
  businessId: string,
  filters: ListPaymentsQueryInput,
): Promise<repository.PaymentWithCustomer[]> {
  return repository.listPayments(businessId, filters);
}

export async function getPaymentStats(businessId: string): Promise<{
  totalRevenue: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  byMethod: Record<string, number>;
}> {
  return repository.getRevenueStats(businessId);
}
