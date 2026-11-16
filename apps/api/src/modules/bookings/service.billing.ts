import { Prisma, type CommerceInvoice } from '@prisma/client';
import type { ServiceRules } from './service.contract.js';

type Tx = Prisma.TransactionClient;

export function serviceAmounts(price: Prisma.Decimal | null, quantity: number, rule: ServiceRules['payment']): {
  total: Prisma.Decimal; deposit: Prisma.Decimal;
} {
  const total = (price ?? new Prisma.Decimal(0)).mul(quantity);
  const deposit = rule.kind === 'AFTER_SERVICE' ? new Prisma.Decimal(0) : rule.kind === 'FULL' ? total
    : rule.kind === 'FIXED' ? new Prisma.Decimal(rule.amountMinor).div(100) : total.mul(rule.percent).div(100).toDecimalPlaces(2);
  return { total, deposit };
}

export async function serviceCharge(tx: Tx, invoice: CommerceInvoice, verified: Prisma.Decimal, due: Prisma.Decimal): Promise<{
  charge: Prisma.Decimal; review: boolean; cancelled: boolean;
} | null> {
  const visit = await tx.serviceVisit.findUnique({
    where: { invoiceId: invoice.id },
    select: { businessId: true, customerId: true, holdUntil: true, state: true, paymentReviewAt: true },
  });
  if (!visit) return null;
  const closed = ['EXPIRED', 'CANCELLED', 'NO_SHOW'].includes(visit.state);
  const payable = visit.businessId === invoice.businessId && visit.customerId === invoice.customerId && !closed &&
    (visit.state !== 'HELD' || (visit.holdUntil !== null && +visit.holdUntil > Date.now())) &&
    (invoice.deposit.gt(0) || visit.state === 'COMPLETED');
  const charge = visit.state === 'HELD' ? Prisma.Decimal.max(0, invoice.deposit.minus(verified)) : due;
  return { charge: payable ? Prisma.Decimal.min(charge, due) : new Prisma.Decimal(0),
    review: Boolean(visit.paymentReviewAt) || (closed && verified.gt(0)), cancelled: closed };
}
