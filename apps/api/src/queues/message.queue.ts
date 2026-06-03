import { Queue, type JobsOptions } from 'bullmq';
import { redis } from '../config/redis.js';
import type { ParsedIncomingMessage } from '../modules/webhook/webhook.types.js';

export const INCOMING_MESSAGES_QUEUE_NAME = 'incoming-messages';

export interface MessageJobData {
  businessId: string;
  waMessageId: string;
  message: ParsedIncomingMessage;
  receivedAt: string;
}

export const defaultMessageJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
  removeOnComplete: 100,
  removeOnFail: false,
};

export const incomingMessagesQueue = new Queue<MessageJobData, unknown, string>(INCOMING_MESSAGES_QUEUE_NAME, {
  // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
  connection: redis,
  defaultJobOptions: defaultMessageJobOptions,
});
