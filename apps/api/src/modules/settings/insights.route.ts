import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../middleware/role.middleware.js';
import { InsightsQuerySchema } from './settings.schema.js';

/**
 * Which day to summarise. Absent means today, which is the normal case.
 *
 * A named schema rather than an inline regex, so this route validates its body
 * the way every other route in the codebase does — the check was already
 * correct, but a convention that holds everywhere except one file is a
 * convention someone will eventually not notice.
 */
const RunInsightSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
import { success } from '../../utils/response.js';
import { listInsights, latestInsight } from '../../services/insights/daily-insights.service.js';
import { enqueueInsightForBusiness } from '../../queues/insights.queue.js';

/**
 * The morning summary, read and re-run.
 *
 * Reading it is `revenue.read`, not a settings capability. The summary states
 * what the shop took yesterday, so whoever may see the takings may see this,
 * and whoever may not, may not — putting it behind a weaker gate would leak the
 * day's revenue to every role that can open the dashboard.
 */
export default async function insightRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/insights',
    { preHandler: requireCapability('revenue.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { limit } = InsightsQuerySchema.parse(request.query ?? {});
      return success(reply, await listInsights(request.business!.id, limit));
    },
  );

  app.get(
    '/insights/latest',
    { preHandler: requireCapability('revenue.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return success(reply, await latestInsight(request.business!.id));
    },
  );

  /**
   * Writes today's summary now instead of waiting for the morning.
   *
   * Queued rather than generated inline: it makes a model call, and an owner
   * tapping a button should not hold an HTTP request open for the length of
   * one. Restricted to settings.write because it costs a generation.
   */
  app.post(
    '/insights/run',
    { preHandler: requireCapability('settings.write') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { date } = RunInsightSchema.parse(request.body ?? {});

      await enqueueInsightForBusiness({
        businessId: request.business!.id,
        ...(date ? { date } : {}),
      });

      return success(reply, { queued: true });
    },
  );
}
