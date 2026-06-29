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

function buildCustomerCreate(jobData: MessageJobData, waNumber: string): Prisma.CustomerUncheckedCreateInput {
  const create: Prisma.CustomerUncheckedCreateInput = {
    businessId: jobData.businessId,
    waNumber,
    lastInteractionAt: jobData.message.timestamp,
  };
  const name = optionalStringUpdate(jobData.message.profileName);
  if (name !== undefined) create.name = name;
  return create;
}

function buildCustomerUpdate(jobData: MessageJobData): Prisma.CustomerUpdateInput {
  const update: Prisma.CustomerUpdateInput = {
    lastInteractionAt: jobData.message.timestamp,
  };
  const name = optionalStringUpdate(jobData.message.profileName);
  if (name !== undefined) update.name = name;
  return update;
}

async function processMessage(jobData: MessageJobData): Promise<void> {
  const normalizedPhone = normalizeGhanaPhone(jobData.message.from);
  const rawPayload = toInputJson(jobData.message.rawPayload);

  const messageCreate: Prisma.MessageUncheckedCreateInput = {
    businessId: jobData.businessId,
    waMessageId: jobData.waMessageId,
    direction: MessageDirection.INBOUND,
    type: jobData.message.type,
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
        businessId: jobData.businessId,
        waNumber: normalizedPhone,
      },
    },
    create: buildCustomerCreate(jobData, normalizedPhone),
    update: buildCustomerUpdate(jobData),
  });

  await prisma.$transaction([
    prisma.message.update({
      where: {
        id: message.id,
      },
      data: {
        customerId: customer.id,
      },
    }),
    prisma.business.update({
      where: {
        id: jobData.businessId,
      },
      data: {
        monthlyConvoCount: {
          increment: 1,
        },
      },
    }),
  ]);

  if (jobData.message.media?.id && jobData.message.type === MessageType.IMAGE) {
    try {
      const uploadResult = await downloadFromMetaAndUploadToS3(
        jobData.message.media.id,
        jobData.businessId,
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

          emitMessageFlagged(jobData.businessId, {
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

  if (jobData.message.type === MessageType.TEXT || jobData.message.body) {
    await intentClassificationQueue.add(
      // @ts-expect-error BullMQ v5 type inference issue — NameType resolves incorrectly despite explicit generic
      'classify-message-intent',
      {
        businessId: jobData.businessId,
        messageId: message.id,
        waMessageId: jobData.waMessageId,
      },
      {
        jobId: `intent:${jobData.waMessageId}`,
      },
    );
  }

  const bodyLength = jobData.message.body?.length ?? 0;
  const isAmbiguous = bodyLength < 3 || !jobData.message.body;
  if (isAmbiguous && jobData.message.type === MessageType.TEXT) {
    emitMessageFlagged(jobData.businessId, {
      messageId: message.id,
      requiresReview: true,
      intent: 'UNKNOWN',
    });
  }
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
            businessId: job.data.businessId,
          },
        });
      }

      logger.error(
        {
          error,
          jobId: job.id,
          waMessageId: job.data.waMessageId,
          businessId: job.data.businessId,
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
