import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireCapability } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import { prisma } from '../../config/database.js';
import { getUsage } from '../../services/plan/plan.service.js';
import {
  TEMPLATE_KEYS,
  TEMPLATE_LABELS,
  TEMPLATE_DESCRIPTIONS,
  TEMPLATE_VARIABLES,
  parseTemplateConfig,
} from '../../services/templates/template-engine.js';
import { UpdateBusinessSchema } from './settings.schema.js';

const BUSINESS_SELECT = {
  id: true,
  name: true,
  phone: true,
  ownerName: true,
  plan: true,
  trialEndsAt: true,
  waWebhookVerified: true,
  monthlyConvoCount: true,
  notifyOnNewOrder: true,
  notifyOnLowStock: true,
  notifyOnPayment: true,
  replyTemplates: true,
  createdAt: true,
} as const;

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const canRead = { preHandler: requireCapability('settings.read') };

  app.get('/businesses/me', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const business = await prisma.business.findUnique({
      where: { id: request.business!.id },
      select: BUSINESS_SELECT,
    });
    return success(reply, business);
  });

  app.patch(
    '/businesses/me',
    { preHandler: requireCapability('settings.write') },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const body = UpdateBusinessSchema.parse(request.body);
    // exactOptionalPropertyTypes: strip undefined keys so optional fields
    // don't fail Prisma's BusinessUpdateInput type check.
    const data = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const business = await prisma.business.update({
      where: { id: request.business!.id },
      data,
        select: BUSINESS_SELECT,
      });
      return success(reply, business);
    },
  );

  /** Plan usage for the billing screen: what is used, what is left, what resets. */
  app.get('/businesses/me/usage', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const usage = await getUsage(request.business!.id);
    return success(reply, usage);
  });

  /**
   * Auto-reply template catalogue.
   *
   * The UI renders from this rather than a hardcoded list, so the editable keys
   * can never drift from the keys the reply engine actually reads — which is
   * exactly how owner customisation was silently broken before.
   */
  app.get('/settings/templates', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const business = await prisma.business.findUnique({
      where: { id: request.business!.id },
      select: { replyTemplates: true },
    });

    const config = parseTemplateConfig(business?.replyTemplates);

    return success(
      reply,
      TEMPLATE_KEYS.map((key) => ({
        key,
        label: TEMPLATE_LABELS[key],
        description: TEMPLATE_DESCRIPTIONS[key],
        variables: TEMPLATE_VARIABLES[key],
        text: config.overrides[key] ?? null,
        enabled: !config.disabled.includes(key),
      })),
    );
  });
}
