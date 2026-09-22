import { Queue, type JobsOptions } from 'bullmq';
import { redis } from '../config/redis.js';

export const INSIGHTS_QUEUE_NAME = 'daily-insights';

/**
 * When the morning summary is written.
 *
 * 06:20 UTC, which is 06:20 in Accra — Ghana keeps UTC+0 all year, so no
 * conversion is needed and none is done anywhere in this feature.
 *
 * The time is before most of these shops open and after the night's messages
 * have landed. The odd minute is deliberate: on the hour is when every
 * scheduled job in every system fires, and there is no reason to join them.
 */
export const INSIGHTS_CRON = '20 6 * * *';

export interface InsightsJobData {
  /**
   * Which shop. Absent on the scheduled job, which fans out into one job per
   * shop — so a single slow or broken tenant delays only itself, and a retry
   * re-runs one summary rather than four hundred.
   */
  businessId?: string;
  /** `YYYY-MM-DD`. Absent means yesterday, computed when the job runs. */
  date?: string;
  /** Send it to the owner on WhatsApp as well as storing it. */
  send?: boolean;
}

export const defaultInsightsJobOptions: JobsOptions = {
  // Two attempts, not five. A summary that fails twice is not worth retrying
  // into the afternoon: by then it is no longer a morning summary, and
  // tomorrow's run covers the same shop anyway.
  attempts: 2,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: 200,
  removeOnFail: 100,
};

export const insightsQueue = new Queue<InsightsJobData, unknown, string>(INSIGHTS_QUEUE_NAME, {
  // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
  connection: redis,
  defaultJobOptions: defaultInsightsJobOptions,
});

/**
 * Installs the daily schedule.
 *
 * BullMQ keys a repeatable job by its name and pattern, so every API instance
 * calling this on boot converges on one schedule rather than N — which is what
 * makes this safe to run from a process that may be replicated.
 *
 * The old schedule is removed first so a changed cron expression takes effect
 * on deploy. Without that, editing `INSIGHTS_CRON` leaves the previous
 * repeatable job in Redis for ever and the summary arrives twice.
 */
export async function scheduleDailyInsights(): Promise<void> {
  const existing = await insightsQueue.getRepeatableJobs();

  for (const job of existing) {
    if (job.name === 'daily-insights-fanout' && job.pattern !== INSIGHTS_CRON) {
      await insightsQueue.removeRepeatableByKey(job.key);
    }
  }

  await insightsQueue.add(
    // @ts-expect-error BullMQ v5 NameType inference
    'daily-insights-fanout',
    {},
    { repeat: { pattern: INSIGHTS_CRON }, jobId: 'daily-insights-fanout' },
  );
}

/** Queues one shop's summary. Used by the fan-out and by the manual trigger. */
export async function enqueueInsightForBusiness(data: InsightsJobData): Promise<void> {
  await insightsQueue.add(
    // @ts-expect-error BullMQ v5 NameType inference
    'daily-insight',
    data,
  );
}
