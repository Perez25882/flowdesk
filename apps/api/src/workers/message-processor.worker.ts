import * as Sentry from '@sentry/node';
import { Queue, Worker } from 'bullmq';
import { MessageDirection, MessageType, Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redis, redisSubscriber } from '../config/redis.js';
import { emitMessageFlagged } from '../services/sse/sse.events.js';
import {
  downloadFromMetaAndUploadToS3,
  isLikelyMoMoScreenshot,
} from '../services/s3/media.js';
import {
  INCOMING_MESSAGES_QUEUE_NAME,
  type MessageJobData,
} from '../queues/message.queue.js';
import { moveToDeadLetter } from './dead-letter.worker.js';

export const INTENT_CLASSIFICATION_QUEUE_NAME = 'intent-classification';
const WORKER_CONCURRENCY = 2;

interface IntentClassificationJobData {
  businessId: string;
  messageId: string;
  waMessageId: string;
}

const intentClassificationQueue = new Queue<IntentClassificationJobData, unknown, string>(
  INTENT_CLASSIFICATION_QUEUE_NAME,
  {
    // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1_000,
      },
      removeOnComplete: 100,
      removeOnFail: false,
    },
  },
);

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
  });
}

function normalizeGhanaPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (digits.startsWith('233') && digits.length === 12) {
    return digits;
  }

  if (digits.startsWith('0') && digits.length === 10) {
    return `233${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `233${digits}`;
  }

  return digits;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function optionalStringUpdate(value: string | undefined): string | undefined {
  return value;
}

function buildCustomerCreate(
  jobData: MessageJobData,
  waNumber: string,
  businessId: string,
): Prisma.CustomerUncheckedCreateInput {
  const create: Prisma.CustomerUncheckedCreateInput = {
    businessId,
    waNumber,
    lastInteractionAt: jobData.message.timestamp,
    // This message is FROM the customer, so it opens Meta's 24-hour service
    // window. Only inbound may set this — see the field docs on Customer.
    lastInboundAt: jobData.message.timestamp,
  };
  const name = optionalStringUpdate(jobData.message.profileName);
  if (name !== undefined) create.name = name;
  return create;
}

function buildCustomerUpdate(jobData: MessageJobData): Prisma.CustomerUpdateInput {
  const update: Prisma.CustomerUpdateInput = {
    lastInteractionAt: jobData.message.timestamp,
    lastInboundAt: jobData.message.timestamp,
  };
  const name = optionalStringUpdate(jobData.message.profileName);
  if (name !== undefined) update.name = name;
  return update;
}

/**
 * Resolves the tenant that owns the receiving WhatsApp number. Returns null for
 * an unknown number — Meta can deliver for a number that was disconnected, and
 * that must not be treated as a processing failure worth retrying.
 */
async function resolveBusinessId(phoneNumberId: string): Promise<string | null> {
  const business = await prisma.business.findFirst({
    where: { waPhoneNumberId: phoneNumberId, active: true, deletedAt: null },
    select: { id: true },
  });

  return business?.id ?? null;
}

async function processMessage(jobData: MessageJobData): Promise<void> {
  const businessId = await resolveBusinessId(jobData.businessPhoneNumberId);

  if (!businessId) {
    logger.warn(
      { phoneNumberId: jobData.businessPhoneNumberId, waMessageId: jobData.waMessageId },
      'Inbound message for an unknown or inactive business — discarding',
    );
    return;
  }

  const normalizedPhone = normalizeGhanaPhone(jobData.message.from);
  const rawPayload = toInputJson(jobData.message.rawPayload);

  const messageCreate: Prisma.MessageUncheckedCreateInput = {
    businessId,
    waMessageId: jobData.waMessageId,
    direction: MessageDirection.INBOUND,
    type: jobData.message.type,
    createdAt: jobData.message.timestamp,
    rawPayload,
    processed: false,
  };
  const body = optionalStringUpdate(jobData.message.body);
  if (body !== undefined) messageCreate.body = body;

  const messageUpdate: Prisma.MessageUpdateInput = {
    type: jobData.message.type,
    rawPayload,
    processingError: null,
  };
  if (body !== undefined) messageUpdate.body = body;

  const message = await prisma.message.upsert({
    where: {
      waMessageId: jobData.waMessageId,
    },
    create: messageCreate,
    update: messageUpdate,
  });

  const customer = await prisma.customer.upsert({
    where: {
      businessId_waNumber: {
        businessId,
        waNumber: normalizedPhone,
      },
    },
    create: buildCustomerCreate(jobData, normalizedPhone, businessId),
    update: buildCustomerUpdate(jobData),
  });

  // Inbound messages are never counted against the plan: the allowance covers
  // outbound conversations (what Meta bills for), and inbound must always be
  // accepted regardless of plan state so no customer order is ever lost.
  await prisma.message.update({
    where: { id: message.id },
    data: { customerId: customer.id },
  });

  if (jobData.message.media?.id && jobData.message.type === MessageType.IMAGE) {
    try {
      const uploadResult = await downloadFromMetaAndUploadToS3(
        jobData.message.media.id,
        businessId,
        jobData.message.media.mimeType ?? 'image/jpeg',
      );

      if (uploadResult) {
        const mediaUpdate: Prisma.MessageUpdateInput = {
          mediaUrl: uploadResult.url,
          mediaKey: uploadResult.key,
        };
        if (jobData.message.media.mimeType !== undefined) {
          mediaUpdate.mediaType = jobData.message.media.mimeType;
        }
        await prisma.message.update({
          where: { id: message.id },
          data: mediaUpdate,
        });

        if (isLikelyMoMoScreenshot(jobData.message.media.mimeType ?? 'image/jpeg', jobData.message.body)) {
          await prisma.message.update({
            where: { id: message.id },
            data: {
              requiresReview: true,
            },
          });

          emitMessageFlagged(businessId, {
            messageId: message.id,
            requiresReview: true,
            intent: 'PAYMENT',
          });
        }
      }
    } catch (error: unknown) {
      logger.error({ error, messageId: message.id }, 'Failed to process media message');
    }
  }

  // Every message goes to the classifier, including media and stickers. The
  // classifier marks body-less messages processed without classifying them —
  // previously those were never enqueued at all and stayed "unprocessed"
  // forever, permanently inflating the review queue.
  await intentClassificationQueue.add(
    // @ts-expect-error BullMQ v5 type inference issue — NameType resolves incorrectly despite explicit generic
    'classify-message-intent',
    {
      businessId,
      messageId: message.id,
      waMessageId: jobData.waMessageId,
    },
    {
      jobId: `intent-${jobData.waMessageId}`,
    },
  );
}

export const messageProcessorWorker = new Worker<MessageJobData>(
  INCOMING_MESSAGES_QUEUE_NAME,
  async (job) => {
    try {
      await processMessage(job.data);
    } catch (error: unknown) {
      if (env.SENTRY_DSN) {
        Sentry.captureException(error, {
          tags: {
            worker: 'message-processor',
          },
          extra: {
            jobId: job.id,
            waMessageId: job.data.waMessageId,
            phoneNumberId: job.data.businessPhoneNumberId,
          },
        });
      }

      logger.error(
        {
          error,
          jobId: job.id,
          waMessageId: job.data.waMessageId,
          phoneNumberId: job.data.businessPhoneNumberId,
        },
        'Message processor job failed',
      );

      throw error;
    }
  },
  {
    // ioredis v5.11.0 vs BullMQ's bundled v5.10.1 type mismatch
    // @ts-expect-error library interop — versions are runtime-compatible
    connection: redisSubscriber,
    concurrency: WORKER_CONCURRENCY,
  },
);

messageProcessorWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, waMessageId: job.data.waMessageId }, 'Message processed');
});

messageProcessorWorker.on('failed', async (job, error) => {
  logger.error(
    {
      error,
      jobId: job?.id,
      waMessageId: job?.data.waMessageId,
      attemptsMade: job?.attemptsMade,
    },
    'Message processor job exhausted or failed',
  );

  if (job && job.attemptsMade >= 3) {
    await prisma.message.updateMany({
      where: {
        waMessageId: job.data.waMessageId,
      },
      data: {
        processingError: error.message,
      },
    });

    await moveToDeadLetter(INCOMING_MESSAGES_QUEUE_NAME, job.id, job.data, error);
  }
});
