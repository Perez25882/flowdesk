import { Prisma, PaymentMethod } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';

/**
 * Turning a flagged MoMo screenshot into something the owner can act on.
 *
 * A screenshot is a claim: the customer says the money has moved and nobody has
 * checked yet. `PaymentConfidence.CLAIMED` already means exactly that, so a
 * flagged screenshot is recorded as a CLAIMED payment rather than living on the
 * Message row waiting for a queue to notice it. Two reasons:
 *
 *  - `Message.requiresReview` is not ours. The intent classifier recomputes it
 *    after this worker has run, so a captioned screenshot the assistant decides
 *    it has answered has its flag cleared and disappears from the queue. A
 *    Payment row cannot be cleared by anything outside this module.
 *  - It makes "needs checking" one question against one table — every unvoided
 *    CLAIMED payment — instead of a union of two entity types with two separate
 *    notions of "already dealt with".
 *
 * The amount is 0 until the owner reads it off the image, which is the honest
 * encoding of "unknown": no total anywhere reads it, because every aggregate
 * filters on `ATTESTED_PAYMENT` and a CLAIMED row is never attested. The API
 * reports an unknown amount as null rather than as zero.
 */

/**
 * Which network the caption names, if it names one.
 *
 * A guess is only made when the customer said it themselves. Everything else is
 * OTHER — inventing MOMO_MTN because it is the commonest network in Ghana would
 * put a fabricated method one tap away from being attested and counted in the
 * by-method breakdown. The confirm step makes the owner state it.
 */
export function guessMethodFromCaption(caption: string | null | undefined): PaymentMethod {
  const text = caption?.toLowerCase() ?? '';

  if (text.includes('mtn') || text.includes('momo')) return PaymentMethod.MOMO_MTN;
  if (text.includes('vodafone') || text.includes('telecel')) return PaymentMethod.MOMO_VODAFONE;
  if (text.includes('airteltigo') || text.includes('airtel') || text.includes('tigo')) {
    return PaymentMethod.MOMO_AIRTELTIGO;
  }
  if (text.includes('bank') || text.includes('transfer')) return PaymentMethod.BANK_TRANSFER;

  return PaymentMethod.OTHER;
}

function claimNote(detectionConfidence: number, reasons: string[]): string {
  const because = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
  return (
    `Payment screenshot sent on WhatsApp, flagged automatically ` +
    `(confidence ${detectionConfidence.toFixed(2)}${because}). ` +
    `The amount is unknown until someone reads it off the image.`
  );
}

export interface ScreenshotClaimInput {
  businessId: string;
  customerId: string;
  /** The archive key of the image. Doubles as the claim's identity — see below. */
  screenshotKey: string;
  /** Set only once the bytes are actually in the bucket. */
  screenshotUrl?: string | undefined;
  caption?: string | null;
  detectionConfidence: number;
  reasons: string[];
}

export interface ScreenshotClaimResult {
  paymentId: string;
  /** False when a claim for this image already existed. */
  created: boolean;
}

/**
 * Records the claim, once per image.
 *
 * Meta redelivers webhooks and BullMQ retries jobs, so this runs more than once
 * for the same screenshot as a matter of routine. `screenshotKey` is derived
 * from the WhatsApp message id, so it is the same string on every replay and a
 * lookup on it is what keeps one screenshot from becoming three claims.
 *
 * That check is a read followed by a write, so two workers racing the same
 * message could still both insert. The proper fix is a unique index — see the
 * note in the handover — but the failure mode without it is one extra row in the
 * review queue for the owner to dismiss, not money counted twice: a CLAIMED row
 * moves no totals, and confirming one does not confirm the other.
 */
export async function recordScreenshotClaim(
  input: ScreenshotClaimInput,
): Promise<ScreenshotClaimResult> {
  const existing = await prisma.payment.findFirst({
    where: { businessId: input.businessId, screenshotKey: input.screenshotKey },
    select: { id: true },
  });

  if (existing) {
    return { paymentId: existing.id, created: false };
  }

  const data: Prisma.PaymentUncheckedCreateInput = {
    businessId: input.businessId,
    customerId: input.customerId,
    amount: new Prisma.Decimal(0),
    method: guessMethodFromCaption(input.caption),
    direction: 'IN',
    confidence: 'CLAIMED',
    screenshotKey: input.screenshotKey,
    notes: claimNote(input.detectionConfidence, input.reasons),
    ...(input.screenshotUrl !== undefined ? { screenshotUrl: input.screenshotUrl } : {}),
  };

  const payment = await prisma.payment.create({ data, select: { id: true } });

  logger.info(
    {
      paymentId: payment.id,
      businessId: input.businessId,
      customerId: input.customerId,
      detectionConfidence: input.detectionConfidence,
    },
    'Recorded a payment claim from a MoMo screenshot',
  );

  return { paymentId: payment.id, created: true };
}

/**
 * Points an existing claim at the archived image.
 *
 * Separate from recording the claim because the claim is made from the caption
 * and the customer's balance — both in hand immediately — while the upload
 * happens afterwards and may never succeed. Scoped by business as well as key
 * so a crafted key cannot reach another tenant's row.
 */
export async function attachScreenshotArchive(
  businessId: string,
  screenshotKey: string,
  screenshotUrl: string,
): Promise<void> {
  await prisma.payment.updateMany({
    where: { businessId, screenshotKey },
    data: { screenshotUrl },
  });
}

/**
 * Takes the screenshot's message out of the message review queue once the claim
 * it produced has been dealt with.
 *
 * Best-effort and deliberately timid: a message can be flagged for reasons that
 * have nothing to do with payment — an assistant draft waiting to be sent, most
 * commonly — and clearing someone else's flag would hide work the owner still
 * has to do. When the message is carrying a draft the flag is left alone.
 */
export async function clearScreenshotReviewFlag(
  businessId: string,
  screenshotKey: string,
): Promise<void> {
  try {
    const message = await prisma.message.findFirst({
      where: { businessId, mediaKey: screenshotKey, requiresReview: true },
      select: { id: true, aiReplyStatus: true },
    });

    if (!message || message.aiReplyStatus === 'DRAFT') return;

    await prisma.message.update({
      where: { id: message.id },
      data: { requiresReview: false },
    });
  } catch (error: unknown) {
    logger.error({ error, businessId, screenshotKey }, 'Failed to clear screenshot review flag');
  }
}
