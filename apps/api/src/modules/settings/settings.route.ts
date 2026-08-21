import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { requireCapability } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import { prisma } from '../../config/database.js';
import { getUsage } from '../../services/plan/plan.service.js';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_KEYS,
  TEMPLATE_LABELS,
  TEMPLATE_DESCRIPTIONS,
  TEMPLATE_VARIABLES,
  parseTemplateConfig,
} from '../../services/templates/template-engine.js';
import { UpdateBusinessSchema } from './settings.schema.js';

/**
 * Fields returned by `GET /businesses/me`.
 *
 * A closed allow-list: a new column is invisible to the dashboard until it is
 * added here, which reads to the owner as "my setting did not save".
 */
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
  businessType: true,
  businessTypeOther: true,
  businessProfile: true,
  businessPolicyNotes: true,
  profileUpdatedAt: true,
  aiAssistMode: true,
  catalogueMode: true,
  createdAt: true,
} as const;

/**
 * Merges a profile patch over what is stored.
 *
 * A JSON column assigned through `prisma.update` is REPLACED, not merged. The
 * setup wizard saves a section at a time, so a straight assignment would drop
 * every answer the current request did not happen to include — the owner fills
 * in delivery areas and their opening hours silently disappear.
 *
 * Explicit `null` is preserved: it means "asked, and the answer is none", which
 * is different from a key that was never sent.
 */
export function mergeBusinessProfile(
  stored: unknown,
  patch: Record<string, unknown> | null,
): Record<string, unknown> | null {
  // An explicit null clears the profile outright.
  if (patch === null) return null;

  const base =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}

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
      const data: Prisma.BusinessUncheckedUpdateInput = Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      );

      // The profile is a JSON column, so it must be merged rather than assigned
      // — see `mergeBusinessProfile`. Touching any profile field also stamps
      // `profileUpdatedAt`, which is how the assistant knows whether a fact is
      // fresh enough to quote.
      const touchesProfile =
        body.businessProfile !== undefined ||
        body.businessType !== undefined ||
        body.businessTypeOther !== undefined ||
        body.businessPolicyNotes !== undefined;

      if (body.businessProfile !== undefined) {
        const existing = await prisma.business.findUnique({
          where: { id: request.business!.id },
          select: { businessProfile: true },
        });

        const merged = mergeBusinessProfile(
          existing?.businessProfile ?? null,
          body.businessProfile as Record<string, unknown> | null,
        );

        // A JSON column is cleared with Prisma.DbNull; a plain null is a type
        // error here and would otherwise be read as "leave unchanged".
        data.businessProfile = merged === null ? Prisma.DbNull : (merged as Prisma.InputJsonValue);
      }

      if (touchesProfile) {
        data.profileUpdatedAt = new Date();
      }

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
        /** The owner's customised wording, or null when they have not changed it. */
        text: config.overrides[key] ?? null,
        /**
         * The wording used when there is no override. Served so the dashboard
         * can show and restore it without keeping its own copy — it previously
         * did, and the two drifted apart with nothing to catch it.
         */
        defaultText: DEFAULT_TEMPLATES[key],
        enabled: !config.disabled.includes(key),
      })),
    );
  });
}
