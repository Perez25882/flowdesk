import type { WhatsAppConnectionState } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { decryptSecretCompat } from '../../utils/crypto.js';
import { maskPhone, normalizeGhanaPhone } from '../../utils/phone.js';
import { classifyMetaError, WhatsAppSendError, type MetaFailure } from './meta-errors.js';

/**
 * Tenant-scoped WhatsApp Cloud API client.
 *
 * Flowdesk runs the Meta "Tech Provider" model: one Meta app, and every business
 * connects its OWN WhatsApp Business Account through Embedded Signup. Each
 * tenant therefore has its own phone number id and its own access token, and a
 * message must only ever leave through the credentials of the business it
 * belongs to.
 *
 * The previous implementation fell back to the platform's global number when a
 * business had not connected one. That silently sent one tenant's customer a
 * message from Flowdesk's number — and any reply was then routed by
 * phone_number_id into whichever tenant owned that number. This client has no
 * fallback: an unconnected business cannot send, full stop.
 */

const GRAPH_BASE = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Meta throttles per phone number. This cap is deliberately below the published
 * limit so bursts queue rather than earning a 429 that would count against the
 * number's quality rating.
 */
const SENDS_PER_SECOND_PER_NUMBER = 15;

export interface TenantCredentials {
  businessId: string;
  phoneNumberId: string;
  accessToken: string;
  businessName: string;
}

export interface SendResult {
  waMessageId: string;
}

/**
 * Loads and validates a tenant's own WhatsApp credentials.
 *
 * Returns null — never a global fallback — when the business cannot send, so
 * every caller has to handle "this tenant is not connected" explicitly.
 */
export async function loadTenantCredentials(
  businessId: string,
): Promise<TenantCredentials | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      waPhoneNumberId: true,
      waAccessToken: true,
      waConnectionState: true,
    },
  });

  if (!business) {
    logger.error({ businessId }, 'Cannot send: business not found');
    return null;
  }

  if (!business.waPhoneNumberId || !business.waAccessToken) {
    logger.warn(
      { businessId },
      'Cannot send: business has no WhatsApp number connected',
    );
    return null;
  }

  // A connection Meta has rejected must not be retried on every message; the
  // owner has to reconnect first. Rate limiting is transient, so it still tries.
  if (
    business.waConnectionState === 'TOKEN_INVALID' ||
    business.waConnectionState === 'NUMBER_UNAVAILABLE'
  ) {
    logger.warn(
      { businessId, state: business.waConnectionState },
      'Cannot send: WhatsApp connection needs the owner to reconnect',
    );
    return null;
  }

  let accessToken: string | null;
  try {
    accessToken = decryptSecretCompat(business.waAccessToken);
  } catch (error: unknown) {
    // Usually means ENCRYPTION_KEY was rotated; the stored token is unreadable.
    logger.error({ error, businessId }, 'Cannot send: stored WhatsApp token could not be decrypted');
    await markConnectionState(businessId, 'TOKEN_INVALID', 'Stored credentials could not be read');
    return null;
  }

  if (!accessToken) return null;

  return {
    businessId,
    phoneNumberId: business.waPhoneNumberId,
    accessToken,
    businessName: business.name,
  };
}

/** Records the health of a tenant's connection so the UI can explain outages. */
export async function markConnectionState(
  businessId: string,
  state: WhatsAppConnectionState,
  error: string | null,
): Promise<void> {
  await prisma.business
    .update({
      where: { id: businessId },
      data: {
        waConnectionState: state,
        waConnectionError: error,
        waConnectionCheckedAt: new Date(),
      },
    })
    .catch((updateError: unknown) => {
      logger.error({ updateError, businessId }, 'Failed to record WhatsApp connection state');
    });
}

/**
 * Per-number send throttle, enforced in Redis so it holds across API instances.
 *
 * Returns the milliseconds to wait when the number is at its limit, or 0 when
 * the send may proceed.
 */
async function reserveSendSlot(phoneNumberId: string): Promise<number> {
  const key = `flowdesk:wa:rate:${phoneNumberId}:${Math.floor(Date.now() / 1000)}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 2);
    }

    if (count > SENDS_PER_SECOND_PER_NUMBER) {
      return 1_000 - (Date.now() % 1_000);
    }

    return 0;
  } catch {
    // Redis down: prefer delivering the message over enforcing a soft limit.
    return 0;
  }
}

async function callGraph(
  credentials: TenantCredentials,
  body: Record<string, unknown>,
): Promise<SendResult> {
  const wait = await reserveSendSlot(credentials.phoneNumberId);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${GRAPH_BASE}/${env.META_API_VERSION}/${credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    const raw = await response.text();

    if (!response.ok) {
      const failure = classifyMetaError(response.status, raw);
      await handleFailure(credentials, failure);
      throw new WhatsAppSendError(credentials.businessId, failure);
    }

    const data = JSON.parse(raw) as { messages?: Array<{ id: string }> };
    const waMessageId = data.messages?.[0]?.id;

    if (!waMessageId) {
      throw new WhatsAppSendError(credentials.businessId, {
        kind: 'UNKNOWN',
        code: null,
        message: 'Meta accepted the request but returned no message id',
        httpStatus: response.status,
        retryable: true,
        connectionState: null,
      });
    }

    // A success clears any previously recorded problem.
    await clearConnectionErrorIfSet(credentials.businessId);

    return { waMessageId };
  } catch (error: unknown) {
    if (error instanceof WhatsAppSendError) throw error;

    // Abort or network failure — transient by nature.
    const failure: MetaFailure = {
      kind: 'TRANSIENT',
      code: null,
      message: error instanceof Error ? error.message : 'Network error',
      httpStatus: 0,
      retryable: true,
      connectionState: null,
    };
    throw new WhatsAppSendError(credentials.businessId, failure);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleFailure(
  credentials: TenantCredentials,
  failure: MetaFailure,
): Promise<void> {
  logger.error(
    {
      businessId: credentials.businessId,
      kind: failure.kind,
      code: failure.code,
      httpStatus: failure.httpStatus,
      message: failure.message,
    },
    'Meta WhatsApp API rejected a send',
  );

  if (failure.connectionState) {
    await markConnectionState(credentials.businessId, failure.connectionState, failure.message);
  }
}

async function clearConnectionErrorIfSet(businessId: string): Promise<void> {
  await prisma.business
    .updateMany({
      // updateMany so a no-op costs nothing when the connection is already fine.
      where: { id: businessId, NOT: { waConnectionState: 'ACTIVE' } },
      data: {
        waConnectionState: 'ACTIVE',
        waConnectionError: null,
        waConnectionCheckedAt: new Date(),
      },
    })
    .catch(() => undefined);
}

/** Sends a free-form text message. Only valid inside the 24-hour window. */
export async function sendText(
  credentials: TenantCredentials,
  to: string,
  text: string,
): Promise<SendResult> {
  const recipient = normalizeGhanaPhone(to);

  logger.info(
    {
      businessId: credentials.businessId,
      to: maskPhone(recipient),
      length: text.length,
    },
    'Sending WhatsApp text',
  );

  return callGraph(credentials, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { body: text },
  });
}

/** Sends an approved template — the only message type allowed outside 24 hours. */
export async function sendTemplate(
  credentials: TenantCredentials,
  to: string,
  templateName: string,
  languageCode: string,
  components?: Array<Record<string, unknown>>,
): Promise<SendResult> {
  const recipient = normalizeGhanaPhone(to);

  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: languageCode },
  };

  if (components && components.length > 0) {
    template.components = components;
  }

  logger.info(
    { businessId: credentials.businessId, to: maskPhone(recipient), templateName },
    'Sending WhatsApp template',
  );

  return callGraph(credentials, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template,
  });
}
