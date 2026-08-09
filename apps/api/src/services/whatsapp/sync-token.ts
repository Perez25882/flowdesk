import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { encryptSecret, decryptSecretCompat } from '../../utils/crypto.js';

/**
 * Development convenience: pushes the token from `.env` onto the one business
 * that owns `META_PHONE_NUMBER_ID`, so you can paste a fresh Meta token, restart,
 * and keep testing.
 *
 * Disabled outside development on purpose. Flowdesk runs the Tech Provider
 * model, where each business supplies its own token through Embedded Signup —
 * a platform-wide token in the environment has no legitimate role in
 * production, and silently overwriting a tenant's credentials from server
 * config would be exactly the kind of cross-tenant surprise this codebase is
 * built to avoid.
 */
export async function syncAccessTokenFromEnv(): Promise<void> {
  if (env.NODE_ENV !== 'development') {
    return;
  }

  const envToken = env.META_ACCESS_TOKEN;
  const phoneNumberId = env.META_PHONE_NUMBER_ID;

  if (!envToken || !phoneNumberId) {
    return;
  }

  const business = await prisma.business.findFirst({
    where: { waPhoneNumberId: phoneNumberId },
    select: { id: true, name: true, waAccessToken: true },
  });

  if (!business) {
    logger.debug(
      { phoneNumberId },
      'No business owns META_PHONE_NUMBER_ID; skipping development token sync',
    );
    return;
  }

  const currentToken = decryptSecretCompat(business.waAccessToken);
  if (currentToken === envToken) {
    return;
  }

  await prisma.business.update({
    where: { id: business.id },
    data: {
      waAccessToken: encryptSecret(envToken),
      // A new token may well fix a connection Meta had rejected.
      waConnectionState: 'ACTIVE',
      waConnectionError: null,
      waConnectionCheckedAt: new Date(),
    },
  });

  logger.info(
    { businessId: business.id, name: business.name },
    'Synced WhatsApp access token from environment (development only)',
  );
}
