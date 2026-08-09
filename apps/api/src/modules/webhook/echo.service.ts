import { MessageDirection, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import type { ParsedEchoMessage } from './webhook.types.js';

/**
 * Persists messages the owner sent from the WhatsApp Business app.
 *
 * Under coexistence the owner keeps replying from their own phone. Those sends
 * never pass through Flowdesk, so without recording them here the dashboard
 * would show handled conversations as ignored, and the assistant would reply on
 * top of the owner. Stored as OUTBOUND with `sentFromApp` set, which is what
 * the auto-reply suppression check reads.
 */

/**
 * Echoes arrive for whichever number Meta delivered them to. A number that has
 * since been disconnected is not an error worth retrying — drop it.
 */
async function resolveBusinessId(phoneNumberId: string): Promise<string | null> {
  const business = await prisma.business.findFirst({
    where: { waPhoneNumberId: phoneNumberId, active: true, deletedAt: null },
    select: { id: true },
  });

  return business?.id ?? null;
}

export async function recordAppEcho(echo: ParsedEchoMessage): Promise<boolean> {
  const businessId = await resolveBusinessId(echo.businessPhoneNumberId);

  if (!businessId) {
    logger.warn(
      { phoneNumberId: echo.businessPhoneNumberId, waMessageId: echo.waMessageId },
      'Echo for an unknown or inactive business — discarding',
    );
    return false;
  }

  const waNumber = normalizeGhanaPhone(echo.to);

  // The customer may not exist yet: the owner can open a conversation from
  // their phone before that person has ever messaged the business.
  const customer = await prisma.customer.upsert({
    where: { businessId_waNumber: { businessId, waNumber } },
    create: { businessId, waNumber, lastInteractionAt: echo.timestamp },
    update: { lastInteractionAt: echo.timestamp },
    select: { id: true },
  });

  const rawPayload = JSON.parse(JSON.stringify(echo.rawPayload)) as Prisma.InputJsonValue;

  // Already processed: an echo needs no classification and must never be
  // queued for one, or the assistant would treat the owner's own words as a
  // customer request.
  await prisma.message.upsert({
    where: { waMessageId: echo.waMessageId },
    create: {
      businessId,
      customerId: customer.id,
      waMessageId: echo.waMessageId,
      direction: MessageDirection.OUTBOUND,
      type: echo.type,
      body: echo.body ?? null,
      createdAt: echo.timestamp,
      rawPayload,
      sentFromApp: true,
      processed: true,
      processedAt: new Date(),
    },
    update: { body: echo.body ?? null, rawPayload, sentFromApp: true },
  });

  logger.info(
    { businessId, customerId: customer.id, waMessageId: echo.waMessageId },
    'Recorded owner reply sent from the WhatsApp Business app',
  );

  return true;
}
