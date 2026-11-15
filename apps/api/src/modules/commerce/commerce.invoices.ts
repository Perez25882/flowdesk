import { Prisma, type CommerceInvoice, type CommercePreparation, type OrderStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../utils/errors.js';

type Tx = Prisma.TransactionClient;
type InvoiceAmounts = { paid: Prisma.Decimal; verified: Prisma.Decimal; due: Prisma.Decimal; nextCharge: Prisma.Decimal };
type InvoiceView = CommerceInvoice & InvoiceAmounts & {
  order: { referenceNumber: string; status: OrderStatus };
  preparation: CommercePreparation | null;
  state: string;
  openRequestId: string | null;
  followupAvailable: boolean;
};

export async function invoiceAmounts(tx: Tx, invoice: CommerceInvoice): Promise<InvoiceAmounts> {
  const ledger = await tx.payment.findMany({
    where: { businessId: invoice.businessId, customerId: invoice.customerId, orderId: invoice.orderId,
      voidedAt: null, confidence: { not: 'CLAIMED' } },
    select: { amount: true, direction: true, confidence: true, paystackSettlement: { select: { id: true } } },
  });
  let paid = new Prisma.Decimal(0);
  let verified = new Prisma.Decimal(0);
  for (const item of ledger) {
    const amount = item.direction === 'IN' ? item.amount : item.amount.neg();
    paid = paid.plus(amount);
    if (item.direction === 'OUT' || (item.confidence === 'GATEWAY_CONFIRMED' && item.paystackSettlement)) {
      verified = verified.plus(amount);
    }
  }
  const due = Prisma.Decimal.max(0, invoice.total.minus(paid));
  const nextCharge = paid.lte(0) && invoice.deposit.gt(0) ? Prisma.Decimal.min(due, invoice.deposit) : due;
  return { paid, verified, due, nextCharge };
}

export async function invoiceView(tx: Tx, id: string, businessId: string): Promise<InvoiceView> {
  const invoice = await tx.commerceInvoice.findUnique({
    where: { id_businessId: { id, businessId } },
    include: { order: { select: { referenceNumber: true, status: true } }, preparation: true },
  });
  if (!invoice) throw new NotFoundError('Invoice not found');
  const amounts = await invoiceAmounts(tx, invoice);
  const [request, unresolved] = await Promise.all([
    tx.paymentRequest.findFirst({ where: { businessId, customerId: invoice.customerId, orderId: invoice.orderId,
      status: 'PENDING', expiresAt: { gt: new Date() } }, select: { id: true } }),
    tx.paystackInitialization.findFirst({ where: { businessId, customerId: invoice.customerId, orderId: invoice.orderId,
      state: { in: ['INITIALIZING', 'REVIEW'] } }, select: { reference: true } }),
  ]);
  const state = invoice.order.status === 'CANCELLED' ? 'CANCELLED'
    : unresolved ? 'REVIEW_REQUIRED'
      : amounts.verified.gte(invoice.total) ? 'VERIFIED_PAID'
        : amounts.due.lte(0) ? 'RECORDED_PAID'
          : amounts.paid.gt(0) ? 'PARTIALLY_PAID'
            : request ? 'PAYMENT_PENDING' : 'ISSUED';
  const followupAvailable = invoice.order.status === 'FULFILLED' && Boolean(await tx.customer.findFirst({ where: {
    id: invoice.customerId, businessId, commerceFollowup: true, commerceConsentId: { not: null },
    deletedAt: null, blacklisted: false, waNumberInvalid: false, lastInboundAt: { gt: new Date(Date.now() - 86_400_000) },
    business: { commercePolicy: { enabled: true, allowFollowup: true } },
  }, select: { id: true } }));
  return { ...invoice, ...amounts, state, openRequestId: request?.id ?? null, followupAvailable };
}

/** Invoked inside the existing customer and order relationship lock. */
export async function requireInvoiceCheckout(
  tx: Tx, businessId: string, customerId: string, orderId: string | null | undefined, amountMinor: number,
): Promise<void> {
  if (!orderId) return;
  const invoice = await tx.commerceInvoice.findFirst({ where: { businessId, customerId, orderId },
    include: { order: { select: { status: true, totalAmount: true } } } });
  if (!invoice) return;
  const { nextCharge } = await invoiceAmounts(tx, invoice);
  if (invoice.order.status === 'CANCELLED' || !invoice.order.totalAmount.eq(invoice.total) ||
      !nextCharge.gt(0) || !nextCharge.mul(100).eq(amountMinor)) {
    throw new ConflictError('Payment request no longer matches the invoice balance');
  }
  const differentOpen = await tx.paymentRequest.findFirst({ where: { businessId, customerId, orderId,
    amount: { not: nextCharge }, status: 'PENDING', expiresAt: { gt: new Date() } }, select: { id: true } });
  const unresolved = await tx.paystackInitialization.findFirst({ where: { businessId, customerId, orderId,
    amountMinor: { not: amountMinor }, state: { in: ['INITIALIZING', 'REVIEW'] } }, select: { reference: true } });
  if (differentOpen || unresolved) throw new ConflictError('An earlier payment request requires reconciliation');
}
