import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Paystack transaction and webhook helpers.
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

async function paystackRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<PaystackResponse<T>> {
  const url = `${PAYSTACK_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
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
