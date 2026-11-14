import { Prisma, type WhatsAppTextReceipt } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import type { ParsedEchoMessage, ParsedIncomingMessage } from './webhook.types.js';
import { isMediaMessage, type WhatsAppStatusEvidence } from './webhook.service.js';

const UNBOUND_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TEXT_RECEIPT_RETENTION_MS = 30 * UNBOUND_REVIEW_WINDOW_MS;
const MAX_ATTEMPTS = 12;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

const clean = (value: unknown, max: number): string | null => typeof value === 'string'
  ? value.replaceAll('\0', '').slice(0, max) : null;

export async function acceptTextReceipts(messages: ParsedIncomingMessage[], echoes: ParsedEchoMessage[] = [],
  statuses: WhatsAppStatusEvidence[] = [],
): Promise<void> {
  if (messages.length === 0 && echoes.length === 0 && statuses.length === 0) return;

  const now = new Date();
  const events = [...messages, ...echoes];
  const phones = [...new Set(events.map((message) => message.businessPhoneNumberId))];
  const messageIds = [...new Set(events.map((message) => message.waMessageId))].sort();
  await prisma.$transaction(async (tx) => {
    if (statuses.length) await tx.whatsAppDeliveryReceipt.createMany({ data: statuses, skipDuplicates: true });
    if (!events.length) return;
    // Order admission across concurrent batches without tying it to Redis or
    // to the order in which consumers materialize different phone numbers.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-accept:' || id, 0))
      FROM (SELECT id FROM unnest(ARRAY[${Prisma.join(messageIds)}]::text[]) id ORDER BY id) identities
    `;
    const existing = await tx.whatsAppTextReceipt.findMany({
      where: { waMessageId: { in: messageIds }, OR: [{ reason: null }, { reason: { not: 'MESSAGE_ID_COLLISION' } }] },
      select: { waMessageId: true, phoneNumberId: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    });
    const admittedPhones = new Map(existing.map((row) => [row.waMessageId, row.phoneNumberId]));
    const owners = await tx.$queryRaw<Array<{ id: bigint; phoneNumberId: string; businessId: string; startedAt: Date; endedAt: Date | null }>>`
      SELECT id, "phoneNumberId", "businessId", "startedAt", "endedAt" FROM "whatsapp_phone_ownership"
      WHERE "phoneNumberId" IN (${Prisma.join(phones)})
        AND ("endedAt" IS NULL OR "endedAt" >= ${new Date(now.getTime() - TEXT_RECEIPT_RETENTION_MS)})
      ORDER BY "startedAt" DESC
    `;
    const data: Prisma.WhatsAppTextReceiptCreateManyInput[] = events.map((message) => {
      const echo = 'to' in message;
      const media = !echo && isMediaMessage(message.type) ? message.media : undefined;
      const kind = echo ? 'ECHO' : media ? 'MEDIA' : message.type === 'TEXT' ? 'TEXT' : 'INTERACTION';
      const stale = message.timestamp.getTime() < now.getTime() - TEXT_RECEIPT_RETENTION_MS;
      const future = message.timestamp.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS;
      const startsBefore = (date: Date) => Math.floor(date.getTime() / 1000) * 1000 <= Math.min(now.getTime(), message.timestamp.getTime());
      const bindings = owners.filter((owner) => owner.phoneNumberId === message.businessPhoneNumberId);
      // Meta timestamps have second precision. A transition within the event
      // second is ambiguous when two tenants could have held the number.
      const matching = bindings.filter((owner) => startsBefore(owner.startedAt) &&
        (!owner.endedAt || Math.ceil(owner.endedAt.getTime() / 1000) * 1000 > message.timestamp.getTime()));
      const businessId = matching.length === 1 ? matching[0]!.businessId : stale && bindings.length === 1 ? bindings[0]!.businessId : null;
      const ownerChanged = matching.length === 1 && matching[0]!.endedAt !== null;
      const previousPhone = admittedPhones.get(message.waMessageId);
      const collision = previousPhone !== undefined && previousPhone !== message.businessPhoneNumberId;
      if (!previousPhone) admittedPhones.set(message.waMessageId, message.businessPhoneNumberId);
      const disposition = collision ? 'MESSAGE_ID_COLLISION'
        : stale ? 'STALE_EVENT' : future ? 'FUTURE_EVENT' : ownerChanged ? 'PHONE_OWNER_CHANGED' : null;
      const redact = stale || collision || future;
      return {
        phoneNumberId: message.businessPhoneNumberId,
        waMessageId: message.waMessageId,
        businessId,
        ownershipId: matching.length === 1 ? matching[0]!.id : null,
        kind, messageType: message.type,
        sender: redact ? null : normalizeGhanaPhone(echo ? message.to : message.from),
        echoSender: !redact && echo ? normalizeGhanaPhone(message.from) : null,
        body: redact ? null : clean(message.body, 65_536) ?? (kind === 'TEXT' ? '' : null),
        profileName: redact || echo ? null : clean(message.profileName, 512),
        replyToWaId: redact || echo ? null : clean(message.replyToWaId, 512),
        mediaId: redact ? null : clean(media?.id, 512),
        mediaMime: redact ? null : clean(media?.mimeType, 150),
        mediaDigest: redact ? null : clean(media?.sha256, 128),
        reactionEmoji: redact ? null : clean(message.reaction?.emoji, 64),
        reactionTarget: redact ? null : clean(message.reaction?.reactedToWaMessageId, 512),
        sentAt: message.timestamp,
        receivedAt: now,
        status: disposition ? 'FAILED' : businessId ? 'PENDING' : 'WAITING_MAPPING',
        reason: disposition ?? (businessId ? null : 'PHONE_OWNER_UNVERIFIED'),
        nextAttemptAt: disposition
          ? null
          : businessId
            ? now
            : new Date(now.getTime() + UNBOUND_REVIEW_WINDOW_MS),
        finishedAt: disposition ? now : null,
      };
    });
    await tx.whatsAppTextReceipt.createMany({ data, skipDuplicates: true });
  });
}

export async function lockDueTextReceipt(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
): Promise<WhatsAppTextReceipt | null> {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "whatsapp_text_receipts"
    WHERE "id" = ${id} AND "nextAttemptAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
    FOR UPDATE SKIP LOCKED
  `;
  return locked ? tx.whatsAppTextReceipt.findUniqueOrThrow({ where: { id } }) : null;
}

export type WaitReason = 'PHONE_NOT_ACTIVE' | 'QUEUE_UNAVAILABLE' | 'STORAGE_ERROR' |
  'MEDIA_TIMEOUT' | 'MEDIA_PROVIDER_UNAVAILABLE' | 'MEDIA_CREDENTIALS_UNAVAILABLE' | 'MEDIA_STORAGE_UNAVAILABLE' | 'MEDIA_PROCESSING_FAILED';
type TerminalReason =
  | 'PHONE_OWNER_UNVERIFIED'
  | 'STALE_EVENT'
  | 'PHONE_OWNER_CHANGED'
  | 'MESSAGE_ID_COLLISION'
  | 'MESSAGE_MISSING'
  | 'ECHO_SENDER_MISMATCH'
  | 'MEDIA_UNSUPPORTED'
  | 'MEDIA_INVALID'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_LEASE_RETRY_LIMIT'
  | 'MEDIA_PROVIDER_REJECTED';

export async function failTextReceipt(
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
  reason: WaitReason | TerminalReason,
): Promise<void> {
  await tx.whatsAppTextReceipt.update({
    where: { id: receipt.id },
    data: {
      status: 'FAILED', reason, nextAttemptAt: null, finishedAt: now, leaseToken: null, leaseUntil: null,
      ...(reason === 'STALE_EVENT' ? {
        sender: null, body: null, profileName: null, replyToWaId: null, mediaId: null, mediaMime: null,
        mediaDigest: null, echoSender: null, reactionEmoji: null, reactionTarget: null,
      } : {}),
    },
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
      data: { status: 'FAILED', reason, attempts, nextAttemptAt: null, finishedAt: now, leaseToken: null, leaseUntil: null },
    });
    return;
  }

  const backoffMs = Math.min(5_000 * 2 ** (attempts - 1), 300_000);
  const status =
    reason === 'PHONE_NOT_ACTIVE'
      ? 'WAITING_MAPPING'
      : reason === 'QUEUE_UNAVAILABLE'
        ? 'WAITING_QUEUE'
        : reason.startsWith('MEDIA_') ? 'WAITING_MEDIA' : 'PENDING';
  await tx.whatsAppTextReceipt.update({
    where: { id: receipt.id },
    data: {
      status,
      reason,
      attempts,
      leaseToken: null, leaseUntil: null,
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
      echoSender: null,
      mediaId: null, mediaMime: null, mediaDigest: null,
      reactionEmoji: null, reactionTarget: null,
      leaseToken: null, leaseUntil: null,
    },
  });
}
