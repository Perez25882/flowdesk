import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Paystack transaction, subscription and webhook helpers.
 *
 * Customer creation lives in `paystack-customer.ts`, which is timeout-bounded
 * and degrades to `undefined` when billing is unconfigured. This module once
 * carried a second `createPaystackCustomer` that nothing imported and that
 * returned the numeric id where the rest of the system stores `customer_code` —
 * removed, because two functions with one name and different return values is
 * a trap rather than a convenience.
 */

const PAYSTACK_API_BASE = 'https://api.paystack.co';

/** Paystack signs webhooks with SHA-512, so the hex digest is 128 characters. */
const SIGNATURE_HEX_LENGTH = 128;

/**
 * Matches `paystack-customer.ts`. Without a bound, a Paystack connection that
 * hangs holds the owner's checkout or cancellation request open indefinitely.
 */
const REQUEST_TIMEOUT_MS = 10_000;

interface PaystackInitTransaction {
  email: string;
  amount: number;
  plan?: string;
  callback_url?: string;
  metadata?: Record<string, unknown>;
}

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data?: T;
}

/**
 * Exported so the connect module (subaccounts, hosted charges, verification)
 * shares one client: one timeout, one auth header, one place errors are logged.
 * A second copy would drift, and the copy that drifts is always the one
 * handling money.
 */
export async function paystackRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<PaystackResponse<T>> {
  const url = `${PAYSTACK_API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      logger.error({ status: response.status, body: errorBody, endpoint }, 'Paystack API error');
      throw new Error(`Paystack API error: ${response.status} - ${errorBody}`);
    }

    return (await response.json()) as PaystackResponse<T>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function initializeTransaction(data: PaystackInitTransaction): Promise<{
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}> {
  const result = await paystackRequest<{
    authorization_url: string;
    access_code: string;
    reference: string;
  }>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!result.status || !result.data) {
    throw new Error(`Failed to initialize transaction: ${result.message}`);
  }

  return {
    authorizationUrl: result.data.authorization_url,
    accessCode: result.data.access_code,
    reference: result.data.reference,
  };
}

/** The fields of a Paystack subscription this service actually reasons about. */
export interface PaystackSubscription {
  subscriptionCode: string;
  /**
   * Paystack's `email_token`. Required alongside the code to enable or disable
   * the subscription, and only obtainable by fetching the subscription — which
   * is why cancelling is always a read followed by a write, and why we do not
   * keep a copy of it anywhere.
   */
  emailToken: string;
  /** One of active, non-renewing, attention, completed, cancelled. */
  status: string;
  /** ISO. The end of the period the customer has paid for. Null once cancelled. */
  nextPaymentDate: string | null;
  planCode: string | null;
  amountMinor: number;
  customerCode: string | null;
  /** Reusable payment instrument, when Paystack kept one for this customer. */
  authorizationCode: string | null;
}

interface PaystackSubscriptionPayload {
  subscription_code?: string;
  email_token?: string;
  status?: string;
  next_payment_date?: string | null;
  amount?: number;
  plan?: { plan_code?: string } | string | null;
  customer?: { customer_code?: string } | null;
  authorization?: { authorization_code?: string } | null;
}

function toSubscription(data: PaystackSubscriptionPayload): PaystackSubscription | null {
  if (!data.subscription_code || !data.email_token) return null;

  const planCode =
    typeof data.plan === 'string' ? data.plan : (data.plan?.plan_code ?? null);

  return {
    subscriptionCode: data.subscription_code,
    emailToken: data.email_token,
    status: data.status ?? 'unknown',
    nextPaymentDate: data.next_payment_date ?? null,
    planCode,
    amountMinor: data.amount ?? 0,
    customerCode: data.customer?.customer_code ?? null,
    authorizationCode: data.authorization?.authorization_code ?? null,
  };
}

/**
 * Reads a subscription.
 *
 * Returns null rather than throwing when Paystack does not know the code: a
 * subscription that is gone is a state the caller has to handle anyway, and it
 * is not an outage.
 */
export async function fetchSubscription(code: string): Promise<PaystackSubscription | null> {
  const result = await paystackRequest<PaystackSubscriptionPayload>(
    `/subscription/${encodeURIComponent(code)}`,
  );

  if (!result.status || !result.data) return null;

  return toSubscription(result.data);
}

/**
 * Stops a subscription renewing.
 *
 * Paystack's model has no "change the plan on this subscription" call and no
 * proration, so every downgrade, cancellation and pause goes through here. The
 * subscription goes non-renewing immediately — Paystack sends
 * `subscription.not_renew` now and `subscription.disable` on what would have
 * been the next payment date — and the customer keeps what they paid for until
 * then.
 *
 * Returns false rather than throwing when Paystack refuses, so a subscription
 * that was already disabled (a replayed request, a cancellation made in the
 * Paystack dashboard) reads as "nothing left to do" instead of failing a
 * request that has already achieved its purpose.
 */
export async function disableSubscription(code: string, emailToken: string): Promise<boolean> {
  try {
    const result = await paystackRequest<unknown>('/subscription/disable', {
      method: 'POST',
      body: JSON.stringify({ code, token: emailToken }),
    });

    return result.status;
  } catch (error: unknown) {
    logger.error({ error, code }, 'Failed to disable Paystack subscription');
    return false;
  }
}

/** Puts a non-renewing subscription back on its schedule. */
export async function enableSubscription(code: string, emailToken: string): Promise<boolean> {
  try {
    const result = await paystackRequest<unknown>('/subscription/enable', {
      method: 'POST',
      body: JSON.stringify({ code, token: emailToken }),
    });

    return result.status;
  } catch (error: unknown) {
    logger.error({ error, code }, 'Failed to enable Paystack subscription');
    return false;
  }
}

export interface CreateSubscriptionInput {
  /** Customer code or email. */
  customer: string;
  /** Paystack plan code. */
  plan: string;
  /** A stored authorization to charge. Required for a future `startDate`. */
  authorization?: string;
  /** ISO. When the first debit should happen — how a downgrade is deferred. */
  startDate?: string;
}

/**
 * Creates a subscription, optionally starting on a future date.
 *
 * `start_date` is the whole mechanism behind a scheduled downgrade: the cheaper
 * plan's first charge is placed on the day the current paid period ends, so the
 * customer is never billed twice and never billed early. It needs a stored
 * authorization to charge, which mobile money may not leave behind — so this
 * returns null on refusal rather than throwing, and the caller falls back to
 * asking the owner to check out on the day.
 */
export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<PaystackSubscription | null> {
  try {
    const result = await paystackRequest<PaystackSubscriptionPayload>('/subscription', {
      method: 'POST',
      body: JSON.stringify({
        customer: input.customer,
        plan: input.plan,
        ...(input.authorization ? { authorization: input.authorization } : {}),
        ...(input.startDate ? { start_date: input.startDate } : {}),
      }),
    });

    if (!result.status || !result.data) return null;

    return toSubscription(result.data);
  } catch (error: unknown) {
    logger.error({ error, plan: input.plan }, 'Failed to create Paystack subscription');
    return null;
  }
}

/**
 * Verifies a Paystack webhook signature.
 *
 * `body` must be the exact bytes received. Hashing a re-serialised object
 * compares JSON formatting, not authenticity: key order, escaped unicode and
 * number formatting all differ from what was signed, so a legitimate delivery
 * carrying an accented customer name would be rejected.
 */
export function verifyWebhookSignature(body: Buffer | string, signature: string): boolean {
  // No secret configured means we cannot authenticate the caller. Reject rather
  // than fall through to processing an unverified billing event.
  if (!env.PAYSTACK_SECRET_KEY) {
    logger.error('Paystack webhook received but PAYSTACK_SECRET_KEY is not configured');
    return false;
  }

  // A malformed header decodes to a short buffer rather than throwing, so the
  // shape is validated before comparing.
  if (!new RegExp(`^[a-f0-9]{${SIGNATURE_HEX_LENGTH}}$`, 'i').test(signature)) {
    return false;
  }

  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest('hex');

  // Constant-time comparison — a plain `===` leaks the digest via timing.
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
