import type { BusinessPlan } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { success } from '../../utils/response.js';
import { disableSubscription, fetchSubscription, verifyWebhookSignature } from '../../services/billing/paystack.js';
import {
  applyDueScheduledChange,
  clearSchedule,
  readSchedule,
  startPaymentGrace,
} from '../../services/billing/plan-schedule.js';
import { consumePendingTransaction } from './pending-transaction.js';

interface PaystackWebhookBody {
  event: string;
  data: {
    id?: number;
    reference: string;
    status: string;
    amount: number;
    customer: {
      email: string;
      customer_code: string;
    };
    plan?: string;
    subscription?: {
      subscription_code: string;
      status: string;
    };
    subscription_code?: string;
    metadata?: Record<string, unknown>;
  };
}

interface PaystackWebhookRequest extends FastifyRequest {
  rawBody?: Buffer | string;
}

/**
 * Deliveries already handled, so a replayed event cannot re-apply a plan change.
 * Paystack retries on any non-200, so repeats are routine rather than hostile.
 */
const DEDUPE_PREFIX = 'flowdesk:paystack:seen:';
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Claims an event id. False means it has already been applied. */
async function claimEvent(key: string): Promise<boolean> {
  try {
    const result = await redis.set(`${DEDUPE_PREFIX}${key}`, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (error: unknown) {
    // Redis down: applying a plan change twice is idempotent, so process it
    // rather than drop a payment the customer has already made.
    logger.warn({ error, key }, 'Paystack dedupe unavailable — processing anyway');
    return true;
  }
}

/** The subscription an event is about, whichever shape it arrived in. */
function subscriptionCodeOf(data: PaystackWebhookBody['data']): string | null {
  return data.subscription?.subscription_code ?? data.subscription_code ?? null;
}

export default async function billingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /webhooks/paystack
   *
   * Paystack calls this for every lifecycle event. Mounted outside the
   * auth-protected sub-app so the deliveries don't need a JWT — the signature
   * is the authentication.
   */
  app.post(
    '/webhooks/paystack',
    { config: { rawBody: true } },
    async (request: PaystackWebhookRequest, reply: FastifyReply) => {
      const signature = request.headers['x-paystack-signature'];
      if (typeof signature !== 'string') {
        return reply.status(401).send({ success: false, error: 'Missing signature' });
      }

      const rawBody = request.rawBody;

      // Without the exact bytes there is nothing trustworthy to hash. Verifying
      // a re-serialised body would pass or fail on JSON formatting rather than
      // on authenticity, so refuse instead.
      if (!rawBody) {
        logger.error('Paystack webhook received without a raw body — cannot verify signature');
        return reply.status(400).send({ success: false, error: 'Missing raw body' });
      }

      const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

      if (!verifyWebhookSignature(rawBuffer, signature)) {
        logger.warn({ ip: request.ip }, 'Paystack webhook signature verification failed');
        return reply.status(401).send({ success: false, error: 'Invalid signature' });
      }

      let payload: PaystackWebhookBody;

      try {
        payload = JSON.parse(rawBuffer.toString('utf8')) as PaystackWebhookBody;
      } catch {
        return reply.status(400).send({ success: false, error: 'Invalid JSON payload' });
      }

      const { event, data } = payload;

      logger.info({ event, reference: data?.reference }, 'Paystack webhook received');

      // Acknowledged but ignored: a shape we cannot read must not be retried
      // forever.
      if (!data) {
        return success(reply, { received: true });
      }

      const eventKey = String(data.id ?? data.reference ?? '');

      if (eventKey && !(await claimEvent(`${event}:${eventKey}`))) {
        logger.debug({ event, eventKey }, 'Duplicate Paystack delivery ignored');
        return success(reply, { received: true, duplicate: true });
      }

      if (event === 'charge.success') {
        await applyChargeSuccess(data);
      }

      // Paystack does not retry a failed subscription charge, so this is the
      // whole warning a customer gets. It starts the PRD's 3-day grace rather
      // than stopping the account, and it arrives before the disable does.
      if (event === 'invoice.payment_failed') {
        await applyPaymentFailed(data);
      }

      if (event === 'subscription.disable' || event === 'subscription.not_renew') {
        await applySubscriptionEnded(data);
      }

      return success(reply, { received: true });
    },
  );
}

/** Upgrades the business a successful charge was made for. */
async function applyChargeSuccess(data: PaystackWebhookBody['data']): Promise<void> {
  // Paystack sends `charge.success` for failed captures too; only a settled
  // charge should move a plan.
  if (data.status !== 'success') {
    logger.info({ reference: data.reference, status: data.status }, 'Charge not settled — ignored');
    return;
  }

  // Correlate to a checkout WE initiated. The signature proves the event came
  // from Paystack; this proves the event is for a transaction this API started,
  // for a specific business and price — so a valid signature over an
  // attacker-chosen metadata.businessId cannot upgrade an arbitrary tenant.
  const pending = await consumePendingTransaction(data.reference);

  if (!pending) {
    // A renewal, not a checkout: Paystack charged an existing subscription, so
    // there is no pending record and no plan to move. The one thing worth doing
    // is calling off a payment-failure grace, because the payment we were
    // waiting for has now arrived. That can only ever restore service, never
    // grant a plan, so it does not need the pending-transaction guarantee.
    await clearPaymentGraceForSubscription(subscriptionCodeOf(data));

    logger.info(
      { reference: data.reference },
      'charge.success with no matching pending checkout — treated as a renewal',
    );
    return;
  }

  // Defence in depth: the stored record is authoritative, but if the event's
  // own metadata disagrees, refuse rather than guess.
  const metadataBusinessId = data.metadata?.businessId;
  if (typeof metadataBusinessId === 'string' && metadataBusinessId !== pending.businessId) {
    logger.error(
      { reference: data.reference, metadataBusinessId, pendingBusinessId: pending.businessId },
      'charge.success businessId does not match the initiating checkout — refused',
    );
    return;
  }

  const businessId = pending.businessId;
  const plan = pending.plan;

  // The amount is checked against the price we recorded at checkout, never
  // trusted from the event body.
  if (data.amount < pending.expectedAmount) {
    logger.error(
      { reference: data.reference, businessId, plan, paid: data.amount, expected: pending.expectedAmount },
      'charge.success amount below the plan price — upgrade refused',
    );
    return;
  }

  const subscriptionCode = subscriptionCodeOf(data);

  await prisma.business.update({
    where: { id: businessId },
    data: {
      plan,
      suspendedAt: null,
      suspendReason: null,
      // Recorded so `subscription.disable` can find this business later. It was
      // never written before, which left the column null on every row.
      ...(subscriptionCode ? { paystackSubCode: subscriptionCode } : {}),
    },
  });

  // Paying supersedes anything that was queued: a pause the owner changed their
  // mind about, a downgrade they no longer want, a grace period they have just
  // settled. Leaving it in place would downgrade or lapse the plan they have
  // this moment paid for.
  await clearSchedule(businessId);

  logger.info(
    { businessId, plan, reference: data.reference },
    'Business upgraded after successful payment',
  );

  // Only now that the new charge has actually settled is it safe to stop the
  // old subscription. Doing it at checkout would have left an owner who
  // abandoned the Paystack page with no plan at all. The pending record is
  // consumed atomically above, so a replayed delivery never reaches this.
  if (pending.previousSubscriptionCode && pending.previousSubscriptionCode !== subscriptionCode) {
    await stopSupersededSubscription(businessId, pending.previousSubscriptionCode);
  }
}

/**
 * Disables the subscription an upgrade replaced.
 *
 * Best effort and loudly logged: the customer already has what they paid for,
 * and the failure mode of leaving this undone is a second charge next month,
 * which is exactly the thing worth being told about while it can still be
 * fixed by hand.
 */
async function stopSupersededSubscription(businessId: string, code: string): Promise<void> {
  const previous = await fetchSubscription(code).catch((error: unknown) => {
    logger.error({ error, businessId, code }, 'Could not read the superseded subscription');
    return null;
  });

  const stopped = previous
    ? await disableSubscription(previous.subscriptionCode, previous.emailToken)
    : false;

  if (!stopped) {
    logger.error(
      { businessId, code },
      'Superseded subscription is still live — cancel it in Paystack to avoid a second charge',
    );
    return;
  }

  logger.info({ businessId, code }, 'Superseded subscription disabled after upgrade');
}

/** Calls off a payment-failure grace once the money arrives. */
async function clearPaymentGraceForSubscription(subscriptionCode: string | null): Promise<void> {
  if (!subscriptionCode) return;

  const business = await prisma.business.findFirst({
    where: { paystackSubCode: subscriptionCode },
    select: { id: true },
  });

  if (!business) return;

  const schedule = await readSchedule(business.id);

  if (!schedule || schedule.kind !== 'payment_failed' || schedule.appliedAt) return;

  await clearSchedule(business.id);

  logger.info(
    { businessId: business.id },
    'Renewal succeeded — payment-failure grace period cancelled',
  );
}

/** Starts the 3-day grace the PRD gives a failed renewal. */
async function applyPaymentFailed(data: PaystackWebhookBody['data']): Promise<void> {
  const subscriptionCode = subscriptionCodeOf(data);

  if (!subscriptionCode) {
    logger.warn({ reference: data.reference }, 'Payment failure without a subscription code — ignored');
    return;
  }

  const business = await prisma.business.findFirst({
    where: { paystackSubCode: subscriptionCode },
    select: { id: true, plan: true },
  });

  if (!business) {
    logger.warn({ subscriptionCode }, 'Payment failure for an unknown subscription — ignored');
    return;
  }

  await beginGrace(business.id, business.plan, subscriptionCode);
}

/**
 * Handles a subscription ending.
 *
 * Two very different things arrive as the same event. One is the end we asked
 * for — the owner downgraded, cancelled or paused, and Paystack is confirming
 * on the day. The other is a subscription dying on its own, which in practice
 * means the renewal did not go through.
 *
 * They are told apart by whether a change is already scheduled for this
 * business. A scheduled change is written before Paystack is ever asked to stop
 * the subscription, precisely so this branch cannot mistake one for the other.
 *
 * Suspending on the spot — which is what this did — broke the PRD's promise of
 * a 3-day grace and cut off shops whose card had simply expired, in the middle
 * of a working day, with no warning.
 */
async function applySubscriptionEnded(data: PaystackWebhookBody['data']): Promise<void> {
  const subscriptionCode = subscriptionCodeOf(data);

  // A null code previously fell through to `where: { paystackSubCode: null }`,
  // which matched an arbitrary business — every row had a null column — and
  // suspended it. An event we cannot attribute must change nothing.
  if (!subscriptionCode) {
    logger.warn(
      { reference: data.reference },
      'Subscription event without a subscription code — ignored',
    );
    return;
  }

  const business = await prisma.business.findFirst({
    where: { paystackSubCode: subscriptionCode },
    select: { id: true, plan: true },
  });

  if (!business) {
    logger.warn({ subscriptionCode }, 'Subscription event for an unknown subscription — ignored');
    return;
  }

  const scheduled = await readSchedule(business.id);

  if (scheduled && !scheduled.appliedAt) {
    // Expected. If the paid period has run out this writes the new plan through
    // now instead of waiting for the next read; if it has not, the schedule
    // stands and the customer keeps what they paid for.
    await applyDueScheduledChange(business.id);
    logger.info(
      { businessId: business.id, kind: scheduled.kind },
      'Subscription ended as scheduled',
    );
    return;
  }

  await beginGrace(business.id, business.plan, subscriptionCode);
}

/** Shared entry point for the grace period, with the Redis-outage path spelled out. */
async function beginGrace(
  businessId: string,
  plan: BusinessPlan,
  subscriptionCode: string,
): Promise<void> {
  try {
    await startPaymentGrace(businessId, plan, subscriptionCode);
  } catch (error: unknown) {
    // The grace record could not be written. The delivery has already been
    // marked seen, so Paystack retrying will not help — and the alternative,
    // suspending immediately, is the behaviour being fixed. So the account
    // keeps running and this is logged as something a human must settle: a shop
    // left working for free is recoverable, a shop wrongly shut is not.
    logger.error(
      { error, businessId, subscriptionCode },
      'Could not record the payment-failure grace period — account left running, needs manual review',
    );
  }
}
