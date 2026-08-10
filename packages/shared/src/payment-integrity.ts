/**
 * The trust ladder for money.
 *
 * Flowdesk never holds funds, so a payment is only ever as good as the strongest
 * party willing to vouch for it. Each tier names WHOSE word the record rests on,
 * and a lower tier may never do a higher tier's job.
 */
export const PAYMENT_CONFIDENCES = [
  /** The customer's word. Opens a claim and counts for nothing. */
  'CLAIMED',
  /** The seller's word — they checked their phone and confirmed it landed. */
  'SELLER_ATTESTED',
  /** The telco's word — parsed from a network alert, independent of both parties. */
  'TELCO_MATCHED',
  /** The gateway's word — a signed webhook, with no human in the loop. */
  'GATEWAY_CONFIRMED',
] as const;

export type PaymentConfidence = (typeof PAYMENT_CONFIDENCES)[number];

/**
 * Numeric ordering for the ladder.
 *
 * Postgres enums compare by declaration order but Prisma surfaces them as plain
 * strings, so JavaScript needs this to answer "is this at least an attestation?".
 */
export const PAYMENT_CONFIDENCE_RANK: Record<PaymentConfidence, number> = {
  CLAIMED: 0,
  SELLER_ATTESTED: 1,
  TELCO_MATCHED: 2,
  GATEWAY_CONFIRMED: 3,
};

/** Owner-facing wording. Says whose word it is, never just "verified". */
export const PAYMENT_CONFIDENCE_LABELS: Record<PaymentConfidence, string> = {
  CLAIMED: 'Customer says they paid',
  SELLER_ATTESTED: 'You confirmed it landed',
  TELCO_MATCHED: 'Matched to a network alert',
  GATEWAY_CONFIRMED: 'Confirmed by the payment gateway',
};

/** `OUT` is money going back to the customer — a refund. */
export const PAYMENT_DIRECTIONS = ['IN', 'OUT'] as const;

export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/** The minimum shape needed to decide whether a payment counts. */
export interface AttestablePayment {
  amount: number;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  /** `Date` from Prisma, ISO string over JSON, `null` when live. */
  voidedAt: Date | string | null;
}

/**
 * Does this payment count as money?
 *
 * The one rule the rest of the system defers to. A customer's claim never counts,
 * and voiding removes a payment's effect without destroying the record of it.
 */
export function isAttested(payment: AttestablePayment): boolean {
  if (payment.voidedAt) return false;
  return PAYMENT_CONFIDENCE_RANK[payment.confidence] >= PAYMENT_CONFIDENCE_RANK.SELLER_ATTESTED;
}

/**
 * Net attested money: what came in, less what went back out.
 *
 * May be negative when refunds exceed receipts. That is preserved rather than
 * clamped, matching how `recalculateCustomerTotals` already treats credit.
 */
export function netAttested(payments: readonly AttestablePayment[]): number {
  return payments.reduce((total, payment) => {
    if (!isAttested(payment)) return total;
    return payment.direction === 'IN' ? total + payment.amount : total - payment.amount;
  }, 0);
}
