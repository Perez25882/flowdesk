import * as Sentry from '@sentry/node';
import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redis, redisSubscriber } from '../config/redis.js';

export const DEAD_LETTER_QUEUE_NAME = 'dead-letter';

export interface DeadLetterJobData {
  sourceQueue: string;
  originalJobId: string | undefined;
  payload: unknown;
  error: string;
  failedAt: string;
}

/**
 * Dead-letter queue. Jobs that exhaust all retries in the primary queues are
 * forwarded here so they are never silently lost. Retained for 30 days so an
 * operator can inspect and replay them. This is the durable safety net behind
 * the PRD's "0% message loss" requirement.
 */
export const deadLetterQueue = new Queue<DeadLetterJobData, unknown, string>(DEAD_LETTER_QUEUE_NAME, {
  // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  },
});

/** Forwards a permanently-failed job into the dead-letter queue. */
export async function moveToDeadLetter(
  sourceQueue: string,
  originalJobId: string | undefined,
  payload: unknown,
  error: Error,
): Promise<void> {
  try {
    await deadLetterQueue.add(
      // @ts-expect-error BullMQ v5 NameType inference issue — resolves incorrectly despite explicit generic
      'dead-letter',
      {
        sourceQueue,
        originalJobId,
        payload,
        error: error.message,
        failedAt: new Date().toISOString(),
      },
      originalJobId ? { jobId: `dlq:${sourceQueue}:${originalJobId}` } : undefined,
    );
  } catch (enqueueError: unknown) {
    logger.error(
      { enqueueError, sourceQueue, originalJobId },
      'Failed to enqueue job into dead-letter queue',
    );
  }
}

/**
 * Consumes dead-letter entries: logs, reports to Sentry, and leaves the record
 * in place (removeOnComplete: false) for manual inspection/replay.
 */
export const deadLetterWorker = new Worker<DeadLetterJobData>(
  DEAD_LETTER_QUEUE_NAME,
  async (job) => {
    logger.error(
      {
        sourceQueue: job.data.sourceQueue,
        originalJobId: job.data.originalJobId,
        error: job.data.error,
        failedAt: job.data.failedAt,
      },
      'Job moved to dead-letter queue — requires manual review',
    );

    if (env.SENTRY_DSN) {
      Sentry.captureMessage('Job moved to dead-letter queue', {
        level: 'error',
        tags: { sourceQueue: job.data.sourceQueue },
        extra: {
          originalJobId: job.data.originalJobId,
          error: job.data.error,
          failedAt: job.data.failedAt,
        },
      });
    }
  },
  {
    // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
    connection: redisSubscriber,
    concurrency: 1,
  },
);
