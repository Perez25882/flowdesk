import { Prisma, type PaymentRequestStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { ValidationError } from '../../utils/errors.js';
import { lockPaymentRelationship } from './payment-relationships.js';

export interface PaymentRequestRow {
  id: string;
  businessId: string;
  customerId: string;
  orderId: string | null;
  amount: Prisma.Decimal;
  currency: string;
  reference: string;
  authorizationUrl: string;
  status: PaymentRequestStatus;
  channel: string | null;
  gatewayFee: Prisma.Decimal | null;
  platformFee: Prisma.Decimal | null;
  paidAt: Date | null;
  expiresAt: Date;
  paymentId: string | null;
  createdAt: Date;
}

const ROW_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  orderId: true,
  amount: true,
  currency: true,
  reference: true,
  authorizationUrl: true,
  status: true,
  channel: true,
  gatewayFee: true,
  platformFee: true,
  paidAt: true,
  expiresAt: true,
  paymentId: true,
  createdAt: true,
} satisfies Prisma.PaymentRequestSelect;

export async function createPaymentRequest(data: {
  businessId: string;
  customerId: string;
  orderId: string | null;
  amount: number;
  reference: string;
  authorizationUrl: string;
  accessCode: string | null;
  subaccountCode: string;
  platformFee: number;
  expiresAt: Date;
  createdByStaffId: string | null;
}, tx: Prisma.TransactionClient): Promise<PaymentRequestRow> {
  return tx.paymentRequest.create({
    data: {
      businessId: data.businessId,
      customerId: data.customerId,
      orderId: data.orderId,
      amount: new Prisma.Decimal(data.amount),
      reference: data.reference,
      authorizationUrl: data.authorizationUrl,
      accessCode: data.accessCode,
      subaccountCode: data.subaccountCode,
      platformFee: new Prisma.Decimal(data.platformFee),
      expiresAt: data.expiresAt,
      createdByStaffId: data.createdByStaffId,
    },
    select: ROW_SELECT,
  });
}

/**
 * The request a webhook is about.
 *
 * Looked up by reference alone, with no tenant filter, because the webhook has
 * no tenant to filter by — the reference IS the correlation, and the row it
 * finds is what tells us which business the money belongs to. That is the whole
 * reason the reference is generated here rather than accepted from the payload.
 */
export async function findByReference(reference: string): Promise<
  | (PaymentRequestRow & {
      subaccountCode: string | null;
      customer: { id: string; waNumber: string; name: string | null };
    })
  | null
> {
  return prisma.paymentRequest.findUnique({
    where: { reference },
    select: {
      ...ROW_SELECT,
      subaccountCode: true,
      customer: { select: { id: true, waNumber: true, name: true } },
    },
  });
}

export async function findById(
  id: string,
  businessId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<PaymentRequestRow | null> {
  return tx.paymentRequest.findFirst({
    where: { id, businessId },
    select: ROW_SELECT,
  });
}

export async function listPaymentRequests(
  businessId: string,
  filters: { status?: PaymentRequestStatus; customerId?: string; orderId?: string; limit: number },
): Promise<PaymentRequestRow[]> {
  return prisma.paymentRequest.findMany({
    where: {
      businessId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.orderId ? { orderId: filters.orderId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filters.limit,
    select: ROW_SELECT,
  });
}

/**
 * The customer's open request for an order at the requested amount.
 *
 * Used so asking twice reuses one link rather than sending the customer two
 * different URLs for the same debt, which is how a shop gets paid twice and
 * then has to refund one.
 */
export async function findOpenRequestForOrder(
  businessId: string,
  orderId: string,
  amount: number,
  customerId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<PaymentRequestRow | null> {
  return tx.paymentRequest.findFirst({
    where: {
      businessId,
      orderId,
      customerId,
      status: 'PENDING',
      expiresAt: { gt: new Date() },
      amount: new Prisma.Decimal(amount),
    },
    orderBy: { createdAt: 'desc' },
    select: ROW_SELECT,
  });
}

/**
 * Claims a pending request for settlement, atomically.
 *
 * `updateMany` with `status: 'PENDING'` prevents duplicate claims: the
 * webhook and the reconciliation job can both arrive for the same reference,
 * and exactly one of them gets a count of 1. Reading the row and then writing
 * it would leave a window in which both see PENDING and both create a Payment,
 * which is a duplicate credit on a real customer's ledger.
 */
export async function claimForSettlement(request: PaymentRequestRow): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockPaymentRelationship(tx, request);
    const claimed = await tx.paymentRequest.updateMany({
      where: {
        id: request.id, businessId: request.businessId, customerId: request.customerId,
        orderId: request.orderId, status: 'PENDING',
      },
      data: { status: 'PAID' },
    });
    return claimed.count === 1;
  });
}

/** Records the settlement detail once the Payment row exists. */
export async function recordSettlement(
  request: PaymentRequestRow,
  data: {
    paymentId: string;
    channel: string | null;
    gatewayFee: number | null;
    paidAt: Date;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { businessId, customerId, orderId } = request;
    await lockPaymentRelationship(tx, request, true);
    const payment = await tx.payment.findFirst({
      where: { id: data.paymentId, businessId, customerId, orderId, reference: request.reference },
      select: { id: true },
    });
    if (!payment) throw new ValidationError('Settlement payment does not match the request');
    const updated = await tx.paymentRequest.updateMany({
      where: { id: request.id, businessId, customerId, orderId, status: 'PAID', paymentId: null },
      data: {
        paymentId: data.paymentId,
        channel: data.channel,
        gatewayFee: data.gatewayFee === null ? null : new Prisma.Decimal(data.gatewayFee),
        paidAt: data.paidAt,
      },
    });
    if (updated.count !== 1) throw new ValidationError('Payment request changed during settlement');
  });
}

/** Releases a claim that could not be completed, so it can be settled later. */
export async function releaseClaim(reference: string): Promise<void> {
  await prisma.paymentRequest.updateMany({
    where: { reference, status: 'PAID', paymentId: null },
    data: { status: 'PENDING' },
  });
}

export async function cancelRequest(
  request: PaymentRequestRow,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const { id, businessId, customerId, orderId } = request;
  const updated = await tx.paymentRequest.updateMany({
    where: { id, businessId, customerId, orderId, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });

  return updated.count;
}

/**
 * Closes requests whose window has passed.
 *
 * Only PENDING rows, and only by time — a request that settled after it expired
 * is still a payment, and the settlement path does not consult this at all.
 */
export async function expireStaleRequests(now: Date = new Date()): Promise<number> {
  const expired = await prisma.paymentRequest.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  return expired.count;
}
