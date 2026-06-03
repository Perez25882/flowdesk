import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../config/logger.js';
import { sendWhatsAppMessage } from '../../services/whatsapp/outbound.js';
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

  return repository.createPayment(data, businessId, loggedById);
}

export async function verifyPayment(
  paymentId: string,
  businessId: string,
  verifiedBy: string,
): Promise<repository.PaymentWithCustomer> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }

  if (payment.verified) {
    throw new ValidationError('Payment is already verified');
  }

  const verified = await repository.verifyPaymentWithSideEffects(paymentId, verifiedBy);

  emitPaymentConfirmed(businessId, {
    paymentId: verified.id,
    orderId: verified.orderId ?? '',
    amount: Number(verified.amount),
  });

  await logActivity({
    staffId: verifiedBy,
    action: 'payment.verified',
    resourceId: paymentId,
    resourceType: 'payment',
    note: `Payment of GHS ${Number(verified.amount).toFixed(2)} verified`,
  }).catch(() => {});

  try {
    const orderRef = verified.order?.referenceNumber ?? 'your account';
    await sendWhatsAppMessage(
      verified.customer.waNumber,
      `Payment of GHS ${Number(verified.amount).toFixed(2)} received for ${orderRef}. Thank you!`,
      businessId,
    );
  } catch (error: unknown) {
    logger.error({ error, paymentId: verified.id }, 'Failed to send payment receipt');
  }

  return verified;
}

export async function deletePayment(paymentId: string, businessId: string): Promise<void> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }
  await repository.deletePayment(paymentId, businessId);
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
