import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { success } from '../../utils/response.js';
import { verifyWebhookSignature } from '../../services/billing/paystack.js';
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
    logger.warn(
      { reference: data.reference },
      'charge.success with no matching pending checkout — ignored',
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

  const subscriptionCode = data.subscription?.subscription_code ?? data.subscription_code ?? null;

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

  logger.info(
    { businessId, plan, reference: data.reference },
    'Business upgraded after successful payment',
  );
}

/** Suspends the business whose subscription ended. */
async function applySubscriptionEnded(data: PaystackWebhookBody['data']): Promise<void> {
  const subscriptionCode = data.subscription?.subscription_code ?? data.subscription_code ?? null;

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
    select: { id: true },
  });

  if (!business) {
    logger.warn({ subscriptionCode }, 'Subscription event for an unknown subscription — ignored');
    return;
  }

  await prisma.business.update({
    where: { id: business.id },
    data: {
      suspendedAt: new Date(),
      suspendReason: 'Subscription cancelled or payment failed',
    },
  });

  logger.info({ businessId: business.id }, 'Business suspended due to subscription issue');
}
