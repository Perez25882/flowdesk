import { Worker } from 'bullmq';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import {
  INSIGHTS_QUEUE_NAME,
  enqueueInsightForBusiness,
  type InsightsJobData,
} from '../queues/insights.queue.js';
import { enqueueOutboundMessage } from '../queues/outbound.queue.js';
import {
  businessesWantingInsights,
  generateDailyInsight,
  markInsightSent,
  previousDay,
} from '../services/insights/daily-insights.service.js';

/**
 * Writes the morning summaries.
 *
 * Two job shapes on one queue. The scheduled job carries no business id and
 * fans out into one job per shop; each of those writes one summary. The fan-out
 * exists so a slow tenant delays only itself and a retry re-runs one shop
 * rather than the whole estate — four hundred summaries behind one hung Groq
 * call is a job that never finishes and a morning nobody hears about.
 */

/**
 * Low on purpose. These jobs each make a model call, and they all become
 * runnable at the same instant; letting twenty run at once is how a scheduled
 * feature takes down the reply path it shares a provider with.
 */
const WORKER_CONCURRENCY = 3;

async function fanOut(): Promise<void> {
  const businesses = await businessesWantingInsights();

  for (const business of businesses) {
    await enqueueInsightForBusiness({
      businessId: business.id,
      send: business.insightsToWhatsApp,
    });
  }

  logger.info({ count: businesses.length }, 'Daily summaries queued');
}

async function writeOne(data: InsightsJobData): Promise<void> {
  const businessId = data.businessId;
  if (!businessId) return;

  const day = data.date ? new Date(`${data.date}T00:00:00.000Z`) : previousDay();
  const insight = await generateDailyInsight(businessId, day);

  // Null means nothing happened yesterday. Deliberately silent: a summary that
  // says "nothing happened" every morning for a fortnight is a notification
  // people mute, and once muted it is gone for the morning that mattered.
  if (!insight) return;

  if (!data.send) return;

  // `markInsightSent` is a conditional update, so a redelivered job cannot put
  // the same summary on the owner's phone twice.
  const forDate = new Date(`${insight.facts.date}T00:00:00.000Z`);
  if (!(await markInsightSent(businessId, forDate))) return;

  await sendToOwner(businessId, `${insight.headline}\n\n${insight.body}`);
}

/**
 * Puts the summary on the owner's phone.
 *
 * Queued as free-form text, which means it only arrives while the 24-hour
 * window with the owner's own number is open. That is a real limitation rather
 * than an oversight: an owner does not message their own shop, so the window is
 * usually shut, and delivering outside it needs an approved Meta template the
 * shop has to register. WhatsApp delivery is therefore opt-in and the dashboard
 * is the default — a summary that silently fails to send is worse than one that
 * was never promised.
 */
async function sendToOwner(businessId: string, text: string): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { phone: true },
  });

  if (!business?.phone) return;

  await enqueueOutboundMessage({
    businessId,
    // An owner summary belongs to no customer's conversation.
    customerId: null,
    to: business.phone,
    body: text,
  });
}

export const insightsWorker = new Worker<InsightsJobData>(
  INSIGHTS_QUEUE_NAME,
  async (job) => {
    if (job.name === 'daily-insights-fanout') return fanOut();
    return writeOne(job.data);
  },
  {
    // @ts-expect-error ioredis vs BullMQ bundled types
    connection: redisSubscriber,
    concurrency: WORKER_CONCURRENCY,
  },
);

insightsWorker.on('failed', (job, error) => {
  logger.error(
    { error, businessId: job?.data?.businessId, attempts: job?.attemptsMade },
    'Daily summary job failed',
  );
});
