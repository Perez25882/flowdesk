import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ExternalServiceError } from '../../utils/errors.js';

const PAYSTACK_CUSTOMER_URL = 'https://api.paystack.co/customer';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Creates the Paystack customer record a subscription will later be attached to.
 *
 * Returns undefined when billing is not configured (local development) so
 * account creation still succeeds — the customer can be created on demand when
 * the owner first subscribes.
 */
export async function createPaystackCustomer(
  email: string,
  name: string,
  phone?: string,
): Promise<string | undefined> {
  if (!features.billing) {
    logger.debug('Paystack not configured — skipping customer creation');
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(PAYSTACK_CUSTOMER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY as string}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        first_name: name,
        ...(phone ? { phone } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      logger.error({ status: response.status, body }, 'Paystack customer creation failed');
      throw new ExternalServiceError('Failed to create Paystack customer');
    }

    const data = (await response.json()) as { data?: { customer_code?: string } };
    return data.data?.customer_code;
  } finally {
    clearTimeout(timeout);
  }
}
