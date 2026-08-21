import { redis } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import type { PlanKey } from './billing.schema.js';

/**
 * Pending checkout transactions, keyed by Paystack reference.
 *
 * The Paystack webhook authenticates with an HMAC signature, which is the right
 * trust boundary — but the handler then trusted `metadata.businessId`/`plan`
 * outright, so a valid signature over an attacker-chosen body could move ANY
 * tenant to ANY plan or suspend it. Correlating each event to a checkout the
 * API itself initiated closes that: the webhook only acts on a reference we
 * stored here, for the business and price we stored, so the signature alone is
 * no longer enough to target an arbitrary tenant.
 *
 * Stored in Redis with a TTL comfortably longer than a checkout would stay open.
 */
const PREFIX = 'flowdesk:paystack:pending:';
const TTL_SECONDS = 24 * 60 * 60;

export interface PendingTransaction {
  reference: string;
  businessId: string;
  plan: PlanKey;
  expectedAmount: number;
  /**
   * The subscription this checkout replaces, when the owner is moving up a tier
   * while already paying for one.
   *
   * Recorded here rather than acted on at checkout time because the old
   * subscription must survive a payment that never completes: cancelling it
   * before the new card is charged would leave someone who abandoned the
   * Paystack page with no plan at all. The webhook disables it once the new
   * charge has actually settled, and the record is consumed atomically, so it
   * happens exactly once.
   */
  previousSubscriptionCode?: string;
}

function keyFor(reference: string): string {
  return `${PREFIX}${reference}`;
}

export async function recordPendingTransaction(tx: PendingTransaction): Promise<void> {
  try {
    await redis.set(keyFor(tx.reference), JSON.stringify(tx), 'EX', TTL_SECONDS);
  } catch (error: unknown) {
    // Non-fatal: the checkout can still complete. The webhook will simply not
    // find a match and will refuse to apply the change until reconciled — safe
    // by default (fail closed on the money path).
    logger.error({ error, reference: tx.reference }, 'Failed to record pending transaction');
  }
}

/**
 * Claims a pending transaction, deleting it so a replayed webhook cannot reuse
 * it. Returns null when there is no matching pending checkout.
 */
export async function consumePendingTransaction(
  reference: string,
): Promise<PendingTransaction | null> {
  try {
    const raw = await redis.getdel(keyFor(reference));
    if (!raw) return null;
    return JSON.parse(raw) as PendingTransaction;
  } catch (error: unknown) {
    logger.error({ error, reference }, 'Failed to read pending transaction');
    return null;
  }
}
