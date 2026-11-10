import { Queue, type QueueOptions } from 'bullmq';

export const INTENT_CLASSIFICATION_QUEUE_NAME = 'intent-classification';

export interface IntentClassificationJobData {
  businessId: string;
  messageId: string;
  waMessageId: string;
}

export function createIntentClassificationQueue(
  options: QueueOptions,
): Queue<IntentClassificationJobData, unknown, 'classify-message-intent'> {
  return new Queue<IntentClassificationJobData, unknown, 'classify-message-intent'>(
    INTENT_CLASSIFICATION_QUEUE_NAME,
    {
      ...options,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    },
  );
}
