import { randomUUID } from 'node:crypto';
import { OrderStatus, type Prisma, type WhatsAppTextReceipt } from '@prisma/client';
import { prisma } from '../config/database.js';
import {
  lockDueTextReceipt,
  delayTextReceipt,
  failTextReceipt,
  type WaitReason,
} from '../modules/webhook/text-receipts.js';
import {
  archiveWhatsAppMedia,
  whatsappMediaKey,
  WhatsAppMediaError,
  type WhatsAppMediaInput,
} from '../services/media/whatsapp-archive.js';
import { assessMoMoScreenshot } from '../services/s3/momo-screenshot.js';
import { mediaArchiveKey } from '../services/s3/media.js';
import {
  attachScreenshotArchive,
  recordScreenshotClaim,
} from '../modules/payments/screenshot-claims.js';

type ResolveOwner = (
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
) => Promise<string | null>;
type Archive = Awaited<ReturnType<typeof archiveWhatsAppMedia>>;
const LEASE_MS = 60_000;

type MediaClaim = {
  receipt: WhatsAppTextReceipt;
  input: WhatsAppMediaInput;
  token: string;
  customerId: string;
  messageId: string;
  key: string;
};

async function claimMedia(
  id: string,
  now: Date,
  resolveOwner: ResolveOwner,
): Promise<MediaClaim | boolean> {
  return prisma.$transaction(async (tx) => {
    const receipt = await lockDueTextReceipt(tx, id, now);
    if (!receipt) return false;
    const businessId = await resolveOwner(tx, receipt, now);
    if (!businessId) return false;
    if (receipt.mediaArchivedAt) return true;
    if (receipt.mediaClaims >= 12) {
      await failTextReceipt(tx, receipt, now, 'MEDIA_LEASE_RETRY_LIMIT');
      if (receipt.messageId)
        await tx.message.updateMany({
          where: { id: receipt.messageId, businessId },
          data: { requiresReview: true, processingError: 'MEDIA_LEASE_RETRY_LIMIT' },
        });
      return false;
    }
    const message = receipt.messageId
      ? await tx.message.findFirst({
          where: {
            id: receipt.messageId,
            businessId,
            direction: 'INBOUND',
            type: receipt.messageType,
            customer: { businessId, waNumber: receipt.sender ?? '' },
          },
          select: { id: true, customerId: true, mediaKey: true, mediaUrl: true },
        })
      : null;
    if (!message?.customerId || !receipt.mediaId) {
      await failTextReceipt(tx, receipt, now, 'MESSAGE_MISSING');
      return false;
    }
    const input: WhatsAppMediaInput = {
      businessId,
      phoneNumberId: receipt.phoneNumberId,
      waMessageId: receipt.waMessageId,
      type: receipt.messageType,
      mediaId: receipt.mediaId,
      mediaMime: receipt.mediaMime,
      mediaDigest: receipt.mediaDigest,
    };
    const expectedLegacyKey = mediaArchiveKey(
      businessId,
      receipt.waMessageId,
      receipt.mediaMime ?? 'image/jpeg',
    );
    const reusableLegacyKey =
      message.mediaKey === expectedLegacyKey &&
      !(await tx.message.findFirst({
        where: { id: { not: message.id }, mediaKey: expectedLegacyKey },
        select: { id: true },
      }));
    // A compatible pre-G1-06 message can already have an archived object.
    if (message.mediaUrl && reusableLegacyKey) {
      await tx.message.update({
        where: { id: message.id, businessId },
        data: { mediaPhoneNumberId: receipt.phoneNumberId },
      });
      await tx.whatsAppTextReceipt.update({ where: { id }, data: { mediaArchivedAt: now } });
      return true;
    }
    const token = randomUUID();
    const key = reusableLegacyKey ? expectedLegacyKey : whatsappMediaKey(input);
    await tx.whatsAppTextReceipt.update({
      where: { id },
      data: {
        leaseToken: token,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        mediaClaims: { increment: 1 },
      },
    });
    await tx.message.update({ where: { id: message.id, businessId }, data: { mediaKey: key } });
    return { receipt, input, token, customerId: message.customerId, messageId: message.id, key };
  });
}

async function assessImage(
  tx: Prisma.TransactionClient,
  claim: MediaClaim,
  archive?: Archive,
): Promise<void> {
  if (claim.input.type !== 'IMAGE') return;
  const {
    input: { businessId },
    customerId,
    messageId,
    key,
    receipt,
  } = claim;
  const orders = await tx.order.findMany({
    where: {
      businessId,
      customerId,
      deletedAt: null,
      status: {
        in: [
          OrderStatus.PENDING,
          OrderStatus.CONFIRMED,
          OrderStatus.PROCESSING,
          OrderStatus.FULFILLED,
        ],
      },
    },
    select: { totalAmount: true, amountPaid: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const mimeType = archive?.mime ?? receipt.mediaMime ?? 'image/jpeg';
  if (!['image/jpeg', 'image/png'].includes(mimeType)) return;
  const assessment = assessMoMoScreenshot({
    mimeType,
    caption: receipt.body,
    hasOpenUnpaidOrder: orders.some((order) => order.totalAmount.gt(order.amountPaid)),
    ...(archive?.dimensions ? { dimensions: archive.dimensions } : {}),
  });
  if (assessment.flagged) {
    await recordScreenshotClaim(
      {
        businessId,
        customerId,
        screenshotKey: key,
        caption: receipt.body,
        detectionConfidence: assessment.confidence,
        reasons: assessment.reasons,
        ...(archive ? { screenshotUrl: archive.url } : {}),
      },
      tx,
    );
    await tx.message.updateMany({
      where: { id: messageId, businessId, customerId },
      data: { requiresReview: true },
    });
  }
  if (archive) await attachScreenshotArchive(businessId, customerId, key, archive.url, tx);
}

const terminal = [
  'MEDIA_UNSUPPORTED',
  'MEDIA_INVALID',
  'MEDIA_TOO_LARGE',
  'MEDIA_PROVIDER_REJECTED',
] as const;

export async function processMediaReceipt(
  id: string,
  now: Date,
  resolveOwner: ResolveOwner,
): Promise<boolean> {
  const claimed = await claimMedia(id, now, resolveOwner);
  if (typeof claimed === 'boolean') return claimed;
  let archive: Archive | undefined;
  let failure: WhatsAppMediaError['reason'] | 'MEDIA_PROCESSING_FAILED' | null = null;
  try {
    archive = await archiveWhatsAppMedia({
      ...claimed.input,
      key: claimed.key,
      recoverStored: claimed.receipt.mediaClaims > 0,
    });
  } catch (error: unknown) {
    failure = error instanceof WhatsAppMediaError ? error.reason : 'MEDIA_PROCESSING_FAILED';
  }

  const media = archive;
  try {
    return await prisma.$transaction(
      async (tx) => {
        const [owned] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "whatsapp_text_receipts" WHERE id = ${id} AND "leaseToken" = ${claimed.token}
          AND "leaseUntil" > timezone('UTC', now()) FOR UPDATE
      `;
        if (!owned) return false;
        const receipt = await tx.whatsAppTextReceipt.findUniqueOrThrow({ where: { id } });
        const completedAt = new Date();
        const businessId = await resolveOwner(tx, receipt, completedAt);
        if (!businessId) return false;
        const [message] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT m.id FROM messages m JOIN customers c ON c.id = m."customerId"
        WHERE m.id = ${claimed.messageId} AND m."businessId" = ${businessId} AND m.direction = 'INBOUND'
          AND c.id = ${claimed.customerId} AND c."businessId" = ${businessId} AND c."waNumber" = ${receipt.sender}
        FOR UPDATE OF m FOR NO KEY UPDATE OF c
      `;
        if (!message) {
          await failTextReceipt(tx, receipt, completedAt, 'MESSAGE_MISSING');
          return false;
        }
        // Revalidate the lease, message and owner before any screenshot or business effect.
        const terminalReason = terminal.find((value) => value === failure);
        if (!terminalReason) await assessImage(tx, claimed, media);
        if (failure || !media) {
          const reason = failure ?? 'MEDIA_PROCESSING_FAILED';
          if (terminalReason) await failTextReceipt(tx, receipt, completedAt, terminalReason);
          else await delayTextReceipt(tx, receipt, completedAt, reason as WaitReason);
          await tx.message.update({
            where: { id: message.id, businessId },
            data: { processingError: reason, requiresReview: true },
          });
          return false;
        }
        await tx.message.update({
          where: { id: message.id, businessId },
          data: {
            mediaKey: media.key,
            mediaType: media.mime,
            mediaUrl: media.url,
            mediaPhoneNumberId: receipt.phoneNumberId,
            processingError: null,
          },
        });
        await tx.whatsAppTextReceipt.update({
          where: { id },
          data: { mediaArchivedAt: completedAt, leaseToken: null, leaseUntil: null, reason: null },
        });
        return true;
      },
      { maxWait: 3_000, timeout: 10_000 },
    );
  } catch {
    await prisma.$transaction(
      async (tx) => {
        const [owned] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "whatsapp_text_receipts" WHERE id = ${id} AND "leaseToken" = ${claimed.token}
        FOR UPDATE SKIP LOCKED
      `;
        if (!owned) return;
        const receipt = await tx.whatsAppTextReceipt.findUniqueOrThrow({ where: { id } });
        const failedAt = new Date();
        const businessId = await resolveOwner(tx, receipt, failedAt);
        if (!businessId) return;
        await delayTextReceipt(tx, receipt, failedAt, 'MEDIA_PROCESSING_FAILED');
        await tx.message.updateMany({
          where: { id: claimed.messageId, businessId, customerId: claimed.customerId },
          data: { requiresReview: true, processingError: 'MEDIA_PROCESSING_FAILED' },
        });
      },
      { maxWait: 3_000, timeout: 10_000 },
    );
    return false;
  }
}
