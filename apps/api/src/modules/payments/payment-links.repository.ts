import { Prisma, type PaymentRequestStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';

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
