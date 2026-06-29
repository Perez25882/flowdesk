import { prisma } from '../../config/database.js';
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

async function persistConnection(
  businessId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<WhatsAppConnectionStatus> {
  const info = await fetchPhoneNumberInfo(phoneNumberId, accessToken);

  await prisma.business.update({
    where: { id: businessId },
    data: {
      waPhoneNumberId: phoneNumberId,
      waAccessToken: encryptSecret(accessToken),
      waWebhookVerified: true,
    },
  });

  logger.info({ businessId, phoneNumberId }, 'WhatsApp connection stored for business');

  return {
    connected: true,
    waPhoneNumberId: phoneNumberId,
    displayPhoneNumber: info.displayPhoneNumber,
    verifiedName: info.verifiedName,
    webhookVerified: true,
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

  return persistConnection(businessId, input.phoneNumberId, accessToken);
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
    select: { waPhoneNumberId: true, waAccessToken: true, waWebhookVerified: true },
  });

  if (!business?.waPhoneNumberId || !business.waAccessToken) {
    return {
      connected: false,
      waPhoneNumberId: null,
      displayPhoneNumber: null,
      verifiedName: null,
      webhookVerified: false,
    };
  }

  return {
    connected: true,
    waPhoneNumberId: business.waPhoneNumberId,
    displayPhoneNumber: null,
    verifiedName: null,
    webhookVerified: business.waWebhookVerified,
  };
}

export async function disconnect(businessId: string): Promise<void> {
  await prisma.business.update({
    where: { id: businessId },
    data: {
      waPhoneNumberId: null,
      waAccessToken: null,
      waWebhookVerified: false,
    },
  });
  logger.info({ businessId }, 'WhatsApp connection removed for business');
}
