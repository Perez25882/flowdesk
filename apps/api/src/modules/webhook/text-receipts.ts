import type { Prisma, WhatsAppTextReceipt } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import type { ParsedIncomingMessage } from './webhook.types.js';

const UNBOUND_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TEXT_RECEIPT_RETENTION_MS = 30 * UNBOUND_REVIEW_WINDOW_MS;
const MAX_ATTEMPTS = 12;

export async function acceptTextReceipts(messages: ParsedIncomingMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const now = new Date();
  // The receipt insert is atomic on its own. A pinned owner is checked again
  // under a lock before any message or job can be created.
  const businesses = await prisma.business.findMany({
    where: {
      waPhoneNumberId: { in: messages.map((message) => message.businessPhoneNumberId) },
      deletedAt: null,
    },
    select: { id: true, waPhoneNumberId: true },
  });
  const owners = new Map(businesses.map((business) => [business.waPhoneNumberId, business.id]));

  await prisma.whatsAppTextReceipt.createMany({
    data: messages.map((message) => {
      const businessId = owners.get(message.businessPhoneNumberId) ?? null;
      const stale = message.timestamp.getTime() < now.getTime() - TEXT_RECEIPT_RETENTION_MS;
      return {
        phoneNumberId: message.businessPhoneNumberId,
        waMessageId: message.waMessageId,
        businessId,
        sender: stale ? null : normalizeGhanaPhone(message.from),
        body: stale ? null : (message.body?.replaceAll('\0', '') ?? ''),
        profileName: stale ? null : (message.profileName?.replaceAll('\0', '') ?? null),
        replyToWaId: stale ? null : message.replyToWaId?.replaceAll('\0', '') || null,
        sentAt: message.timestamp,
        receivedAt: now,
        status: stale ? 'FAILED' : businessId ? 'PENDING' : 'WAITING_MAPPING',
        reason: stale ? 'STALE_EVENT' : businessId ? null : 'PHONE_OWNER_UNVERIFIED',
        nextAttemptAt: stale
          ? null
          : businessId
            ? now
            : new Date(now.getTime() + UNBOUND_REVIEW_WINDOW_MS),
        finishedAt: stale ? now : null,
      };
    }),
    skipDuplicates: true,
  });
}

export async function lockDueTextReceipt(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
): Promise<WhatsAppTextReceipt | null> {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "whatsapp_text_receipts"
    WHERE "id" = ${id} AND "nextAttemptAt" <= ${now}
    FOR UPDATE SKIP LOCKED
  `;
  return locked ? tx.whatsAppTextReceipt.findUniqueOrThrow({ where: { id } }) : null;
}

type WaitReason = 'PHONE_NOT_ACTIVE' | 'QUEUE_UNAVAILABLE' | 'STORAGE_ERROR';
type TerminalReason =
  | 'PHONE_OWNER_UNVERIFIED'
  | 'PHONE_OWNER_CHANGED'
  | 'MESSAGE_ID_COLLISION'
  | 'MESSAGE_MISSING';

export async function failTextReceipt(
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
  reason: WaitReason | TerminalReason,
): Promise<void> {
  await tx.whatsAppTextReceipt.update({
    where: { id: receipt.id },
    data: { status: 'FAILED', reason, nextAttemptAt: null, finishedAt: now },
  });
}

export async function delayTextReceipt(
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
  reason: WaitReason,
): Promise<void> {
  const attempts = receipt.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await tx.whatsAppTextReceipt.update({
      where: { id: receipt.id },
      data: { status: 'FAILED', reason, attempts, nextAttemptAt: null, finishedAt: now },
    });
    return;
  }

  const backoffMs = Math.min(5_000 * 2 ** (attempts - 1), 300_000);
  const status =
    reason === 'PHONE_NOT_ACTIVE'
      ? 'WAITING_MAPPING'
      : reason === 'QUEUE_UNAVAILABLE'
        ? 'WAITING_QUEUE'
        : 'PENDING';
  await tx.whatsAppTextReceipt.update({
    where: { id: receipt.id },
    data: {
      status,
      reason,
      attempts,
      nextAttemptAt: new Date(now.getTime() + backoffMs),
    },
  });
}

export async function completeTextReceipt(
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
): Promise<void> {
  await tx.whatsAppTextReceipt.update({
    where: { id: receipt.id },
    data: {
      status: 'COMPLETED',
      reason: null,
      nextAttemptAt: null,
      finishedAt: now,
      sender: null,
      profileName: null,
      body: null,
      replyToWaId: null,
    },
  });
}
