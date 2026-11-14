import { Worker, UnrecoverableError } from 'bullmq';
import { MessageDirection, MessageType, type Prisma, type WhatsAppSendState } from '@prisma/client';
import { hasCapability } from '@flowdesk/shared';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import {
  loadTenantCredentials,
  sendImage,
  sendTemplate,
  sendText,
  type SendResult,
  type TenantCredentials,
} from '../services/whatsapp/client.js';
import { resolveProductImageMediaId } from '../services/whatsapp/product-photo.js';
import { WhatsAppSendError, describeForOwner } from '../services/whatsapp/meta-errors.js';
import { recordOutboundConversation } from '../services/plan/plan.service.js';
import {
  OUTBOUND_MESSAGES_QUEUE_NAME,
  scheduleOutbound,
  type OutboundJobData,
} from '../queues/outbound.queue.js';
import { moveToDeadLetter } from './dead-letter.worker.js';
import { normalizeGhanaPhone } from '../utils/phone.js';
import { shouldSendAutoReply } from '../services/templates/template-engine.js';

/**
 * Delivers queued outbound messages through each tenant's own WhatsApp number.
 *
 * Concurrency is shared across tenants, but because a failing tenant's jobs fail
 * fast (permanent errors are not retried) one broken connection cannot occupy
 * the workers indefinitely.
 */
const WORKER_CONCURRENCY = 5;

/**
 * Writes the sent message into the conversation log.
 *
 * Without this the Messages view showed only the customer's half, so an owner
 * could not see what had been said on their behalf — and there was no record to
 * reconcile against Meta's conversation billing.
 */
async function recordSentMessage(
  data: OutboundJobData,
  waMessageId: string,
  channel: SentChannel,
): Promise<void> {
  // The type reflects what was actually sent, not what was asked for. A photo
  // that failed to upload went out as text, and logging it as an IMAGE would
  // leave the owner looking at a conversation claiming to contain a picture
  // their customer never received.
  const sentAsImage = channel === 'image';

  await prisma.message
    .create({
      data: {
        businessId: data.businessId,
        customerId: data.customerId,
        waMessageId,
        direction: MessageDirection.OUTBOUND,
        type: sentAsImage ? MessageType.IMAGE : MessageType.TEXT,
        body: data.body,
        processed: true,
        processedAt: new Date(),
        relatedOrderId: data.relatedOrderId ?? null,
        inReplyToMessageId: data.inReplyToMessageId ?? null,
        sentByStaffId: data.sentByStaffId ?? null,
      },
    })
    .catch((error: unknown) => {
      // The customer already received the message; failing to log it must not
      // trigger a retry that would send it twice.
      logger.error(
        { error, businessId: data.businessId, waMessageId },
        'Delivered message but failed to record it',
      );
    });
}

/**
 * Sends the job through the channel Meta will accept for it.
 *
 * The branch is the whole point of `template` being on the job. Inside the
 * 24-hour window a free-form text is cheaper, carries the owner's own wording,
 * and needs no approval. Outside it Meta rejects free-form outright, so a job
 * queued there used to be enqueued, rejected as non-retryable and dead-lettered
 * — or, before that, dropped at the gate with nothing but a log line while the
 * owner believed the customer had been told.
 */
/** What actually went down the wire, so the log records the right message type. */
type SentChannel = 'text' | 'image' | 'template';

async function send(
  credentials: TenantCredentials,
  data: OutboundJobData,
  outboundId?: string,
): Promise<SendResult & { channel: SentChannel }> {
  if (!data.template) {
    // Already resolved by the caller — a receipt's logo, uploaded once and
    // cached on the business row. Checked first because it needs no lookup.
    if (data.waMediaId) {
      return { ...(await sendImage(credentials, data.to, data.waMediaId, data.body, ...(outboundId ? [outboundId] : []))), channel: 'image' };
    }

    // A photo is an enhancement to the sentence, never a replacement for it. If
    // the image cannot be resolved — object gone, Meta refusing the upload —
    // the text still goes out, because a customer who asked about a jacket is
    // better served by the price arriving without the picture than by silence.
    if (data.productImageId) {
      const mediaId = await resolveProductImageMediaId(credentials, data.productImageId);
      if (mediaId) {
        return { ...(await sendImage(credentials, data.to, mediaId, data.body, ...(outboundId ? [outboundId] : []))), channel: 'image' };
      }
      logger.warn(
        { businessId: data.businessId, productImageId: data.productImageId },
        'Product photo could not be prepared; sending the reply as text only',
      );
    }

    return { ...(await sendText(credentials, data.to, data.body, ...(outboundId ? [outboundId] : []))), channel: 'text' };
  }

  const result = await sendTemplate(
    credentials,
    data.to,
    data.template.name,
    data.template.language,
    data.template.parameters.length > 0
      ? [
          {
            type: 'body',
            parameters: data.template.parameters.map((text) => ({ type: 'text', text })),
          },
        ]
      : undefined,
    ...(outboundId ? [outboundId] : []),
  );

  return { ...result, channel: 'template' };
}

/**
 * True when the owner started answering from their own phone after this job was
 * queued.
 *
 * The takeover gate runs at enqueue time, but generation plus queue latency can
 * be several seconds — ample time for the owner to begin replying in the
 * WhatsApp Business app. Re-checking here, immediately before the send, closes
 * that window; without it the assistant talks over a human mid-conversation,
 * which is the failure most likely to make an owner switch the product off.
 */
async function ownerTookOver(data: OutboundJobData): Promise<boolean> {
  if (!data.suppressIfOwnerRepliedSince || !data.customerId) return false;

  const since = new Date(data.suppressIfOwnerRepliedSince);

  const takeover = await prisma.message.findFirst({
    where: { businessId: data.businessId, customerId: data.customerId, sentFromApp: true, createdAt: { gt: since } },
    select: { id: true },
  });

  return takeover !== null;
}

const SEND_LEASE_MS = 90_000;

export async function processDurableOutbound(id: string): Promise<void> {
  const candidate = await prisma.whatsAppSend.findUnique({ where: { id } });
  if (!candidate || !['AUTHORIZED', 'QUEUED', 'RETRY_PENDING'].includes(candidate.state)) return;
  if (candidate.state === 'RETRY_PENDING' && candidate.nextAttemptAt && candidate.nextAttemptAt > new Date()) return;
  const data = candidate.payload as unknown as OutboundJobData;
  const credentials = await loadTenantCredentials(candidate.businessId);
  const lease = new Date(Date.now() + SEND_LEASE_MS);
  const claimed = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM whatsapp_sends WHERE id = ${id} AND state IN ('AUTHORIZED','QUEUED','RETRY_PENDING')
        AND (state <> 'RETRY_PENDING' OR "nextAttemptAt" <= timezone('UTC', now())) FOR UPDATE SKIP LOCKED
    `;
    if (!locked) return false;
    const [business] = await tx.$queryRaw<Array<{ waPhoneNumberId: string | null }>>`
      SELECT "waPhoneNumberId" FROM businesses WHERE id = ${candidate.businessId}
        AND active AND "deletedAt" IS NULL AND "deactivatedAt" IS NULL FOR SHARE
    `;
    let reason = !business || data.businessId !== candidate.businessId ? 'TENANT_UNAVAILABLE' : null;
    if (!reason && (!credentials || business?.waPhoneNumberId !== credentials.phoneNumberId ||
        (candidate.phoneNumberId && candidate.phoneNumberId !== credentials.phoneNumberId))) reason = 'CONNECTION_CHANGED';
    if (!reason && data.customerId) {
      const [recipient] = await tx.$queryRaw<Array<{ waNumber: string; lastInboundAt: Date | null }>>`
        SELECT "waNumber", "lastInboundAt" FROM customers WHERE id = ${data.customerId}
          AND "businessId" = ${candidate.businessId} AND "deletedAt" IS NULL AND NOT blacklisted FOR SHARE
      `;
      if (!recipient || normalizeGhanaPhone(recipient.waNumber) !== normalizeGhanaPhone(data.to)) reason = 'RECIPIENT_NOT_AUTHORIZED';
      else if (!data.template && !shouldSendAutoReply(recipient.lastInboundAt).withinWindow) reason = 'SERVICE_WINDOW_CLOSED';
    }
    if (!reason && data.inReplyToMessageId && !await tx.message.findFirst({
      where: { id: data.inReplyToMessageId, businessId: candidate.businessId, customerId: data.customerId },
      select: { id: true },
    })) reason = 'REPLY_SOURCE_INVALID';
    if (!reason && data.relatedOrderId && !await tx.order.findFirst({
      where: { id: data.relatedOrderId, businessId: candidate.businessId, customerId: data.customerId ?? '', deletedAt: null },
      select: { id: true },
    })) reason = 'ORDER_TARGET_INVALID';
    if (!reason && data.sentByStaffId) {
      const [staff] = await tx.$queryRaw<Array<{ role: 'MANAGER' | 'OPERATIONS' | 'DELIVERY' }>>`
        SELECT role::text FROM staff WHERE id = ${data.sentByStaffId} AND "businessId" = ${candidate.businessId} AND active FOR SHARE
      `;
      if (!staff || !hasCapability(staff.role, 'messages.send')) reason = 'STAFF_NOT_AUTHORIZED';
    }
    if (!reason && data.customerId && data.suppressIfOwnerRepliedSince && await tx.message.findFirst({
      where: { businessId: candidate.businessId, customerId: data.customerId, sentFromApp: true,
        createdAt: { gt: new Date(data.suppressIfOwnerRepliedSince) } }, select: { id: true },
    })) reason = 'OWNER_TAKEOVER';
    await tx.whatsAppSend.update({ where: { id }, data: reason
      ? { state: 'FAILED', reason, nextAttemptAt: null }
      : { state: 'SENDING', phoneNumberId: credentials!.phoneNumberId, leaseUntil: lease, nextAttemptAt: null, attempts: { increment: 1 }, reason: null } });
    return !reason;
  });
  if (!claimed || !credentials) return;

  // A takeover after claiming but before the provider request is still safe to cancel.
  if (await ownerTookOver(data)) {
    await prisma.whatsAppSend.updateMany({ where: { id, state: 'SENDING', leaseUntil: lease },
      data: { state: 'FAILED', reason: 'OWNER_TAKEOVER', leaseUntil: null } });
    return;
  }
  let result: Awaited<ReturnType<typeof send>>;
  try {
    result = await send(credentials, data, id);
  } catch (error) {
    const failure = error instanceof WhatsAppSendError ? error.failure : null;
    const definitive = Boolean(failure && failure.httpStatus >= 400 && failure.httpStatus < 500 &&
      failure.httpStatus !== 408 && (failure.kind !== 'UNKNOWN' || failure.code !== null));
    const retry = definitive && failure?.kind === 'RATE_LIMITED' && candidate.attempts < 4;
    await prisma.whatsAppSend.updateMany({ where: { id, state: 'SENDING', leaseUntil: lease }, data: {
      state: retry ? 'RETRY_PENDING' : definitive ? 'FAILED' : 'REVIEW_REQUIRED',
      reason: definitive ? failure!.kind : 'PROVIDER_OUTCOME_UNKNOWN', leaseUntil: null,
      nextAttemptAt: retry ? new Date(Date.now() + 5_000 * 2 ** candidate.attempts) : null,
    } });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.whatsAppSend.updateMany({
      where: { id, state: 'SENDING', leaseUntil: lease },
      data: { state: 'PROVIDER_ACCEPTED', providerMessageId: result.waMessageId, acceptedAt: new Date(), leaseUntil: null },
    });
    if (!changed.count) return;
    await createOutboundConversationMessage(tx, data, result.waMessageId, result.channel === 'image' ? 'IMAGE' : 'TEXT');
    await applyDeliveryReceipts(tx, id, credentials.phoneNumberId, result.waMessageId, data.to);
  });
  await recordOutboundConversation(data.businessId);
}

async function createOutboundConversationMessage(
  tx: Prisma.TransactionClient, data: OutboundJobData, waMessageId: string, type: 'TEXT' | 'IMAGE',
): Promise<void> {
  await tx.message.create({ data: {
    businessId: data.businessId, customerId: data.customerId, waMessageId, direction: 'OUTBOUND', type, body: data.body,
    processed: true, processedAt: new Date(), relatedOrderId: data.relatedOrderId ?? null,
    inReplyToMessageId: data.inReplyToMessageId ?? null, sentByStaffId: data.sentByStaffId ?? null,
  } });
}

export async function applyDeliveryReceipts(
  tx: Prisma.TransactionClient, id: string, phoneNumberId: string, providerMessageId: string, recipient: string,
): Promise<void> {
  const send = await tx.whatsAppSend.findUniqueOrThrow({ where: { id } });
  const receipts = await tx.whatsAppDeliveryReceipt.findMany({
    where: { phoneNumberId, providerMessageId, recipient: normalizeGhanaPhone(recipient), consumedAt: null },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
  });
  let state: WhatsAppSendState = send.state;
  let { deliveredAt, readAt, reason } = send;
  for (const receipt of receipts) {
    if (receipt.status === 'read') { state = 'READ'; readAt ??= receipt.sentAt; reason = null; }
    if (receipt.status === 'delivered') {
      if (state !== 'READ') state = 'DELIVERED';
      deliveredAt ??= receipt.sentAt;
      reason = null;
    }
    if (receipt.status === 'failed' && state === 'PROVIDER_ACCEPTED') { state = 'FAILED'; reason = 'PROVIDER_DELIVERY_FAILED'; }
  }
  if (!receipts.length) return;
  await tx.whatsAppSend.update({ where: { id }, data: { state, deliveredAt, readAt, reason } });
  await tx.whatsAppDeliveryReceipt.updateMany({
    where: { id: { in: receipts.map((receipt) => receipt.id) } }, data: { consumedAt: new Date() },
  });
}

export async function recoverDurableOutbound(): Promise<void> {
  const now = new Date();
  await prisma.$executeRaw`
    UPDATE whatsapp_sends SET state = 'REVIEW_REQUIRED', reason = 'SEND_WORKER_INTERRUPTED',
      "leaseUntil" = NULL, "updatedAt" = ${now} WHERE id IN (
        SELECT id FROM whatsapp_sends WHERE state = 'SENDING' AND "leaseUntil" <= ${now}
        ORDER BY "leaseUntil" LIMIT 20 FOR UPDATE SKIP LOCKED
      )
  `;
  const pending = await prisma.whatsAppSend.findMany({
    where: { state: { in: ['AUTHORIZED', 'QUEUED', 'RETRY_PENDING'] }, nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' }, take: 20,
  });
  await Promise.allSettled(pending.map((row) => scheduleOutbound(row.id, row.payload as unknown as OutboundJobData)));
  const receipts = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM whatsapp_sends s WHERE EXISTS (
      SELECT 1 FROM whatsapp_delivery_receipts r
      WHERE r."phoneNumberId" = s."phoneNumberId"
        AND (r."providerMessageId" = s."providerMessageId" OR
          (s."providerMessageId" IS NULL AND s.state = 'REVIEW_REQUIRED' AND r."outboundId" = s.id
            AND r."sentAt" >= s."createdAt" - interval '1 minute'))
        AND r.recipient = s.payload->>'to' AND r."consumedAt" IS NULL
    ) ORDER BY s.id LIMIT 20
  `;
  for (const { id } of receipts) await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM whatsapp_sends
      WHERE id = ${id} FOR UPDATE SKIP LOCKED
    `;
    if (!locked) return;
    const send = await tx.whatsAppSend.findUniqueOrThrow({ where: { id } });
    if (!send.phoneNumberId) return;
    const data = send.payload as unknown as OutboundJobData;
    let providerId = send.providerMessageId;
    if (!providerId && send.state === 'REVIEW_REQUIRED') {
      const candidates = await tx.whatsAppDeliveryReceipt.findMany({
        where: { outboundId: id, phoneNumberId: send.phoneNumberId, recipient: data.to, consumedAt: null,
          sentAt: { gte: new Date(send.createdAt.getTime() - 60_000) } },
        distinct: ['providerMessageId'], take: 2, orderBy: { sentAt: 'asc' },
      });
      if (candidates.length !== 1) return;
      const [evidence] = candidates;
      providerId = evidence!.providerMessageId;
      const conflict = await tx.message.findUnique({ where: { waMessageId: providerId }, select: { id: true } });
      if (conflict) return;
      await tx.whatsAppSend.update({ where: { id }, data: {
        providerMessageId: providerId, state: 'PROVIDER_ACCEPTED', acceptedAt: evidence!.sentAt, reason: null,
      } });
      await createOutboundConversationMessage(tx, data, providerId, 'TEXT');
    }
    if (providerId) await applyDeliveryReceipts(tx, id, send.phoneNumberId, providerId, data.to);
  });
  await prisma.$executeRaw`
    DELETE FROM whatsapp_delivery_receipts WHERE id IN (
      SELECT id FROM whatsapp_delivery_receipts WHERE "createdAt" < ${new Date(now.getTime() - 30 * 86_400_000)}
      ORDER BY "createdAt" LIMIT 100 FOR UPDATE SKIP LOCKED
    )
  `;
}

export function startDurableOutboundRecovery(): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout;
  let current: Promise<void>;
  const tick = (): void => {
    current = recoverDurableOutbound()
      .catch((error: Error) => logger.warn({ name: error.name }, 'Outbound recovery pass failed'))
      .finally(() => { if (!stopped) timer = setTimeout(tick, 1_000); });
  };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await current; };
}

async function processOutbound(data: OutboundJobData): Promise<void> {
  if (await ownerTookOver(data)) {
    logger.info(
      { businessId: data.businessId, customerId: data.customerId },
      'Outbound message dropped: owner answered from the WhatsApp Business app while it was queued',
    );
    return;
  }

  const credentials = await loadTenantCredentials(data.businessId);

  if (!credentials) {
    // Not connected, or connection rejected by Meta. Retrying cannot fix this;
    // the owner must reconnect, and they are told via connection state.
    throw new UnrecoverableError(
      `Business ${data.businessId} has no usable WhatsApp connection`,
    );
  }

  try {
    const result = await send(credentials, data);

    // Both channels are recorded identically. Meta bills a template
    // conversation exactly as it bills a free-form one, so an accounting path
    // that only counted `sendText` would under-report the tenant's usage — and
    // a conversation log missing the template sends would show the customer
    // being ignored for a day when they had in fact been told.
    await Promise.all([
      recordSentMessage(data, result.waMessageId, result.channel),
      recordOutboundConversation(data.businessId),
    ]);

    logger.info(
      {
        businessId: data.businessId,
        waMessageId: result.waMessageId,
        template: data.templateKey,
        channel: result.channel,
        metaTemplate: data.template?.name,
      },
      'Outbound WhatsApp message delivered',
    );
  } catch (error: unknown) {
    if (error instanceof WhatsAppSendError && !error.failure.retryable) {
      // Revoked token, closed 24h window, unreachable recipient — all permanent
      // for this message. Retrying wastes quota and delays other tenants.
      // A missing or paused template is the one permanent failure an operator
      // can actually fix, and the one that hits every newly onboarded tenant,
      // so it is logged at error with the template named rather than folded in
      // with unreachable recipients. It still dead-letters below: this message
      // is lost, and the record of it has to say so rather than imply the
      // customer was reached.
      const level = error.failure.kind === 'TEMPLATE_UNAVAILABLE' ? 'error' : 'warn';

      logger[level](
        {
          businessId: data.businessId,
          kind: error.failure.kind,
          code: error.failure.code,
          metaTemplate: data.template?.name,
          guidance: describeForOwner(error.failure.kind),
        },
        'Outbound message permanently failed',
      );
      throw new UnrecoverableError(error.message);
    }

    throw error;
  }
}

export const outboundWorker = new Worker<OutboundJobData>(
  OUTBOUND_MESSAGES_QUEUE_NAME,
  async (job) => job.data.durableSendId ? processDurableOutbound(job.data.durableSendId) : processOutbound(job.data),
  {
    // @ts-expect-error ioredis vs BullMQ bundled types
    connection: redisSubscriber,
    concurrency: WORKER_CONCURRENCY,
    autorun: false,
  },
);

outboundWorker.on('failed', async (job, error) => {
  if (!job) return;

  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  const permanent = error instanceof UnrecoverableError;

  if (exhausted || permanent) {
    logger.error(
      {
        error,
        businessId: job.data.businessId,
        attempts: job.attemptsMade,
        permanent,
      },
      'Outbound message abandoned',
    );

    await moveToDeadLetter(OUTBOUND_MESSAGES_QUEUE_NAME, job.id, job.data, error);
  }
});
