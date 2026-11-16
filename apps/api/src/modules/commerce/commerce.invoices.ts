import { createHash } from 'node:crypto';
import { Prisma, type CommerceInvoice, type CommercePreparation, type OrderStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import type { PaymentRelationship } from '../payments/payment-relationships.js';

type Tx = Prisma.TransactionClient;
type InvoiceAmounts = { paid: Prisma.Decimal; verified: Prisma.Decimal; due: Prisma.Decimal; nextCharge: Prisma.Decimal };
type InvoiceView = CommerceInvoice & InvoiceAmounts & {
  order: { referenceNumber: string; status: OrderStatus } | null;
  preparation: CommercePreparation | null;
  state: string;
  openRequestId: string | null;
  checkout: { reference: string; authorizationUrl: string; expiresAt: Date; amount: Prisma.Decimal } | null;
  checkoutVersion: string;
  followupAvailable: boolean;
};

export async function invoiceAmounts(tx: Tx, invoice: CommerceInvoice): Promise<InvoiceAmounts> {
  const ledger = await tx.payment.findMany({
    where: { ...invoiceFinancialScope(invoice),
      voidedAt: null, confidence: { not: 'CLAIMED' } },
    select: { amount: true, direction: true, confidence: true, paystackSettlement: { select: { id: true } } },
  });
  let paid = new Prisma.Decimal(0);
  let verified = new Prisma.Decimal(0);
  for (const item of ledger) {
    const amount = item.direction === 'IN' ? item.amount : item.amount.neg();
    const verifiedEntry = item.direction === 'OUT' || (item.confidence === 'GATEWAY_CONFIRMED' && item.paystackSettlement);
    if (invoice.orderId || verifiedEntry) paid = paid.plus(amount);
    if (verifiedEntry) verified = verified.plus(amount);
  }
  const due = Prisma.Decimal.max(0, invoice.total.minus(paid));
  const nextCharge = paid.lte(0) && invoice.deposit.gt(0) ? Prisma.Decimal.min(due, invoice.deposit) : due;
  return { paid, verified, due, nextCharge };
}

function invoiceFinancialScope(invoice: CommerceInvoice): {
  businessId: string; customerId: string; orderId: string | null; invoiceId?: string;
} {
  const { businessId, customerId, orderId, id } = invoice;
  return { businessId, customerId, orderId, ...(orderId ? {} : { invoiceId: id }) };
}

export async function findInvoiceForPayment(tx: Tx, scope: PaymentRelationship): Promise<(CommerceInvoice & {
  order: { status: OrderStatus; totalAmount: Prisma.Decimal } | null;
}) | null> {
  if (!scope.invoiceId && !scope.orderId) return null;
  const invoice = await tx.commerceInvoice.findFirst({ where: {
    businessId: scope.businessId, customerId: scope.customerId, orderId: scope.orderId ?? null,
    ...(scope.invoiceId ? { id: scope.invoiceId } : {}),
  }, include: { order: { select: { status: true, totalAmount: true } } } });
  if (scope.invoiceId && !invoice) throw new NotFoundError('Invoice not found');
  return invoice;
}

export function invoiceIsPayable(invoice: CommerceInvoice & { order: { status: OrderStatus; totalAmount: Prisma.Decimal } | null }): boolean {
  return invoice.status === 'ISSUED' && (!invoice.order ||
    (invoice.order.status !== 'CANCELLED' && invoice.order.totalAmount.eq(invoice.total)));
}

async function invoiceCheckoutVersion(tx: Tx, invoice: CommerceInvoice): Promise<string> {
  const scope = invoiceFinancialScope(invoice);
  const [ledger, closed] = await Promise.all([
    tx.payment.findMany({ where: scope, select: { id: true, confidence: true, amount: true, voidedAt: true }, orderBy: { id: 'asc' } }),
    tx.paymentRequest.findMany({ where: { ...scope, OR: [{ status: { not: 'PENDING' } }, { expiresAt: { lte: new Date() } }] },
      select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  return createHash('sha256').update(JSON.stringify([invoice.businessId, invoice.id, invoice.status, ledger, closed])).digest('hex');
}

export async function invoiceView(tx: Tx, id: string, businessId: string): Promise<InvoiceView> {
  const invoice = await tx.commerceInvoice.findUnique({
    where: { id_businessId: { id, businessId } },
    include: { order: { select: { referenceNumber: true, status: true, totalAmount: true } }, preparation: true },
  });
  if (!invoice) throw new NotFoundError('Invoice not found');
  const amounts = await invoiceAmounts(tx, invoice);
  const scope = invoiceFinancialScope(invoice);
  const [request, unresolved, review, checkoutVersion] = await Promise.all([
    tx.paymentRequest.findFirst({ where: { ...scope, status: 'PENDING', expiresAt: { gt: new Date() } },
      select: { id: true, reference: true, authorizationUrl: true, expiresAt: true, amount: true }, orderBy: { createdAt: 'asc' } }),
    tx.paystackInitialization.findFirst({ where: { ...scope, state: { in: ['INITIALIZING', 'REVIEW'] } }, select: { state: true, createdAt: true } }),
    tx.paystackReceipt.findFirst({ where: { businessId, state: 'REVIEW', requestId: { not: null }, reference: { in:
      (await tx.paymentRequest.findMany({ where: scope, select: { reference: true } })).map(({ reference }) => reference),
    } }, select: { id: true } }),
    invoiceCheckoutVersion(tx, invoice),
  ]);
  const initializing = unresolved?.state === 'INITIALIZING' && +unresolved.createdAt > Date.now() - 60_000;
  const changedOrderTotal = invoice.order && !invoice.order.totalAmount.eq(invoice.total);
  const obsoleteRequest = request && (invoice.orderId ? !amounts.nextCharge.eq(request.amount) : amounts.nextCharge.lt(request.amount));
  const state = invoice.status === 'CANCELLED' || invoice.order?.status === 'CANCELLED' ? 'CANCELLED'
    : invoice.status === 'DRAFT' ? 'DRAFT'
    : review || changedOrderTotal || obsoleteRequest || (unresolved && !initializing) ? 'REVIEW_REQUIRED'
      : initializing ? 'CHECKOUT_INITIALIZING'
      : amounts.verified.gte(invoice.total) ? 'VERIFIED_PAID'
        : amounts.due.lte(0) ? 'RECORDED_PAID'
          : amounts.paid.gt(0) ? 'PARTIALLY_PAID'
            : request ? 'PAYMENT_PENDING' : 'ISSUED';
  const followupAvailable = invoice.order?.status === 'FULFILLED' && Boolean(await tx.customer.findFirst({ where: {
    id: invoice.customerId, businessId, commerceFollowup: true, commerceConsentId: { not: null },
    deletedAt: null, blacklisted: false, waNumberInvalid: false, lastInboundAt: { gt: new Date(Date.now() - 86_400_000) },
    business: { commercePolicy: { enabled: true, allowFollowup: true } },
  }, select: { id: true } }));
  const checkout = request && !['CANCELLED', 'DRAFT', 'REVIEW_REQUIRED', 'VERIFIED_PAID', 'RECORDED_PAID'].includes(state) ? request : null;
  return { ...invoice, ...amounts, state, openRequestId: checkout?.id ?? null, checkout, checkoutVersion, followupAvailable };
}

/** Invoked inside the existing customer and order relationship lock. */
export async function requireInvoiceCheckout(
  tx: Tx, scope: PaymentRelationship, amountMinor: number, version?: string,
): Promise<string | null> {
  const invoice = await findInvoiceForPayment(tx, scope);
  if (!invoice) return null;
  if (version && version !== await invoiceCheckoutVersion(tx, invoice)) throw new ConflictError('Invoice changed. Reload it before requesting a new payment.');
  const { nextCharge } = await invoiceAmounts(tx, invoice);
  if (!invoiceIsPayable(invoice) || !nextCharge.gt(0) || (invoice.orderId
    ? !nextCharge.mul(100).eq(amountMinor) : nextCharge.mul(100).lt(amountMinor))) {
    throw new ConflictError('Payment request no longer matches the invoice balance');
  }
  const financialScope = invoiceFinancialScope(invoice);
  const differentOpen = await tx.paymentRequest.findFirst({ where: { ...financialScope,
    amount: { not: new Prisma.Decimal(amountMinor).div(100) }, status: 'PENDING', expiresAt: { gt: new Date() } }, select: { id: true } });
  const unresolved = await tx.paystackInitialization.findFirst({ where: { ...financialScope,
    amountMinor: { not: amountMinor }, state: { in: ['INITIALIZING', 'REVIEW'] } }, select: { reference: true } });
  if (differentOpen || unresolved) throw new ConflictError('An earlier payment request requires reconciliation');
  return invoice.id;
}
