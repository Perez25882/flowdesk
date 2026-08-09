import type { WhatsAppConnectionState } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ConflictError } from '../../utils/errors.js';
import { encryptSecret } from '../../utils/crypto.js';
import {
  exchangeCodeForToken,
  fetchPhoneNumberInfo,
  subscribeWabaToApp,
} from '../../services/whatsapp/meta.js';
import type { EmbeddedSignupInput, ManualConnectInput } from './whatsapp.schema.js';

export interface WhatsAppConnectionStatus {
  connected: boolean;
  waPhoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  webhookVerified: boolean;
  /** Health of the connection — drives the warning banner in Settings. */
  state: WhatsAppConnectionState;
  /** Meta's explanation when the connection is unhealthy. */
  error: string | null;
}

async function ensurePhoneNumberNotInUse(phoneNumberId: string, businessId: string): Promise<void> {
  const existing = await prisma.business.findFirst({
    where: { waPhoneNumberId: phoneNumberId, NOT: { id: businessId } },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError('This WhatsApp number is already connected to another Flowdesk account');
  }
}

/**
 * Confirms the credentials really control the number before storing them.
 *
 * In development with no Meta app configured there is nothing to verify
 * against, so the number is accepted unverified to keep the local pipeline
 * testable. Production always verifies — `assertProductionIntegrations`
 * guarantees the Meta credentials are present there.
 */
async function verifyPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null }> {
  if (!features.whatsapp && env.NODE_ENV !== 'production') {
    logger.warn(
      { phoneNumberId },
      'Meta is not configured — accepting WhatsApp number without verification (development only)',
    );
    return { displayPhoneNumber: null, verifiedName: null };
  }

  return fetchPhoneNumberInfo(phoneNumberId, accessToken);
}

async function persistConnection(
  businessId: string,
  phoneNumberId: string,
  accessToken: string,
  wabaId?: string,
): Promise<WhatsAppConnectionStatus> {
  const info = await verifyPhoneNumber(phoneNumberId, accessToken);

  await prisma.business.update({
    where: { id: businessId },
    data: {
      waPhoneNumberId: phoneNumberId,
      // Encrypted at rest: this token can send messages as the business.
      waAccessToken: encryptSecret(accessToken),
      waWabaId: wabaId ?? null,
      waDisplayNumber: info.displayPhoneNumber,
      waVerifiedName: info.verifiedName,
      waWebhookVerified: true,
      // Reconnecting clears whatever was previously wrong.
      waConnectionState: 'ACTIVE',
      waConnectionError: null,
      waConnectionCheckedAt: new Date(),
    },
  });

  logger.info({ businessId, phoneNumberId, wabaId }, 'WhatsApp connection stored for business');

  return {
    connected: true,
    waPhoneNumberId: phoneNumberId,
    displayPhoneNumber: info.displayPhoneNumber,
    verifiedName: info.verifiedName,
    webhookVerified: true,
    state: 'ACTIVE',
    error: null,
  };
}

/** Self-serve connection via Meta Embedded Signup. */
export async function connectViaEmbeddedSignup(
  input: EmbeddedSignupInput,
  businessId: string,
): Promise<WhatsAppConnectionStatus> {
  await ensurePhoneNumberNotInUse(input.phoneNumberId, businessId);

  const accessToken = await exchangeCodeForToken(input.code);

  if (input.wabaId) {
    await subscribeWabaToApp(input.wabaId, accessToken);
  }

  return persistConnection(businessId, input.phoneNumberId, accessToken, input.wabaId);
}

/** Manual connection using a directly-provided system user token. */
export async function connectManually(
  input: ManualConnectInput,
  businessId: string,
): Promise<WhatsAppConnectionStatus> {
  await ensurePhoneNumberNotInUse(input.phoneNumberId, businessId);
  return persistConnection(businessId, input.phoneNumberId, input.accessToken);
}

export async function getConnectionStatus(businessId: string): Promise<WhatsAppConnectionStatus> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      waPhoneNumberId: true,
      waAccessToken: true,
      waWebhookVerified: true,
      waDisplayNumber: true,
      waVerifiedName: true,
      waConnectionState: true,
      waConnectionError: true,
    },
  });

  if (!business?.waPhoneNumberId || !business.waAccessToken) {
    return {
      connected: false,
      waPhoneNumberId: null,
      displayPhoneNumber: null,
      verifiedName: null,
      webhookVerified: false,
      state: 'DISCONNECTED',
      error: null,
    };
  }

  return {
    // "Connected" means credentials exist. `state` says whether they still work
    // — the UI needs both to distinguish "not set up" from "needs reconnecting".
    connected: true,
    waPhoneNumberId: business.waPhoneNumberId,
    displayPhoneNumber: business.waDisplayNumber,
    verifiedName: business.waVerifiedName,
    webhookVerified: business.waWebhookVerified,
    state: business.waConnectionState,
    error: business.waConnectionError,
  };
}

export async function disconnect(businessId: string): Promise<void> {
  await prisma.business.update({
    where: { id: businessId },
    data: {
      waPhoneNumberId: null,
      waAccessToken: null,
      waWabaId: null,
      waDisplayNumber: null,
      waVerifiedName: null,
      waWebhookVerified: false,
      waConnectionState: 'DISCONNECTED',
      waConnectionError: null,
      waConnectionCheckedAt: new Date(),
    },
  });
  logger.info({ businessId }, 'WhatsApp connection removed for business');
}
