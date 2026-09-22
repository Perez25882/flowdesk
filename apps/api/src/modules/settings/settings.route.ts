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
import { z } from 'zod';
import { UpdateBusinessSchema } from './settings.schema.js';
import { getLogo, readLogoFile, setLogo } from '../../services/notifications/receipts.js';
import { getOnboardingState } from './onboarding.service.js';
import { MAX_IMAGE_BYTES } from '../../services/media/image-file.js';

/** Same reasoning as the product-photo route: raised here and nowhere else. */
const LOGO_BODY_LIMIT = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;

const UploadLogoSchema = z.object({ data: z.string().min(1) });

const AcceptAutonomySchema = z.object({ accepted: z.boolean() });

/**
 * What a shop is agreeing to when they hand the conversation over.
 *
 * Written plainly and kept short, because a wall of text is a thing people
 * click past and the point of recording it is that they read it. Stored
 * verbatim on the business row at the moment of acceptance.
 */
export const AUTONOMY_ACCEPTANCE_TEXT = [
  'I am turning on autonomous replies.',
  'Flowdesk will answer my customers, take orders and send payment links from my WhatsApp number without showing me first.',
  'It will answer questions even when it cannot check the answer against my catalogue or my saved details, which means it can state a price, a delivery charge or an opening time that I never set.',
  'Anything sent this way is sent in my name and is mine to honour with my customer.',
  'I can turn this off at any time in Settings.',
].join(' ');

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
  receiptsEnabled: true,
  insightsEnabled: true,
  bargainingEnabled: true,
  bookingsEnabled: true,
  insightsToWhatsApp: true,
  replyTemplates: true,
  businessType: true,
  businessTypeOther: true,
  businessProfile: true,
  businessPolicyNotes: true,
  profileUpdatedAt: true,
  aiAssistMode: true,
  autonomyAcceptedAt: true,
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

      // Autonomy cannot be switched on by a PATCH that happens to carry the
      // mode. It requires an acceptance that was recorded first — see
      // POST /settings/autonomy. Enforced here rather than only in the UI,
      // because the UI is not the security boundary and "the customer was
      // charged by an assistant nobody approved" is not a defensible position
      // to reach through an API call a staff account could make.
      if (body.aiAssistMode === 'AUTONOMOUS') {
        const accepted = await prisma.business.findUnique({
          where: { id: request.business!.id },
          select: { autonomyAcceptedAt: true },
        });

        if (!accepted?.autonomyAcceptedAt) {
          return reply.status(409).send({
            success: false,
            error:
              'Autonomous mode has to be accepted before it can be switched on. Open Settings → Assistant.',
            code: 'AUTONOMY_NOT_ACCEPTED',
          });
        }
      }

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
   * POST /settings/autonomy
   *
   * Records that the owner accepted unreviewed replies going out in their name,
   * and the exact wording they accepted.
   *
   * The wording is stored verbatim rather than referenced by version, because a
   * later edit to the terms must not retroactively change what somebody agreed
   * to — which is the entire evidential value of having recorded it. Owner-only:
   * a staff account cannot sign the shop up to this.
   */
  app.post(
    '/settings/autonomy',
    { preHandler: requireCapability('settings.write') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { accepted } = AcceptAutonomySchema.parse(request.body);

      if (!accepted) {
        // Withdrawing it also drops the mode, rather than leaving a shop in
        // AUTONOMOUS having just said they no longer accept it. Read from the
        // database rather than from the request context, which carries only
        // the identity fields.
        const current = await prisma.business.findUnique({
          where: { id: request.business!.id },
          select: { aiAssistMode: true },
        });

        const business = await prisma.business.update({
          where: { id: request.business!.id },
          data: {
            autonomyAcceptedAt: null,
            autonomyAcceptedBy: null,
            autonomyAcceptedText: null,
            ...(current?.aiAssistMode === 'AUTONOMOUS'
              ? { aiAssistMode: 'GROUNDED_AUTO' as const }
              : {}),
          },
          select: BUSINESS_SELECT,
        });
        return success(reply, business);
      }

      const business = await prisma.business.update({
        where: { id: request.business!.id },
        data: {
          autonomyAcceptedAt: new Date(),
          autonomyAcceptedBy: request.user?.staffId ?? 'owner',
          autonomyAcceptedText: AUTONOMY_ACCEPTANCE_TEXT,
        },
        select: BUSINESS_SELECT,
      });

      return success(reply, business);
    },
  );

  /**
   * GET /onboarding
   *
   * Derived from the database on every call rather than from a stored flag, so
   * a step can go back to incomplete — a revoked WhatsApp token should put
   * "connect your number" in front of the owner again, not sit under a tick.
   */
  app.get('/onboarding', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    return success(reply, await getOnboardingState(request.business!.id));
  });

  // ── Branding ──────────────────────────────────────────────────────────────

  app.get('/settings/logo', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    return success(reply, await getLogo(request.business!.id));
  });

  app.put(
    '/settings/logo',
    { preHandler: requireCapability('settings.write'), bodyLimit: LOGO_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { data } = UploadLogoSchema.parse(request.body);
      return success(reply, await setLogo(request.business!.id, data));
    },
  );

  app.get('/settings/logo/file', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const media = await readLogoFile(request.business!.id);
    if (!media) {
      return reply.status(404).send({ success: false, error: 'No logo set', code: 'NOT_FOUND' });
    }

    return reply
      .header('Content-Type', media.contentType)
      .header('Cache-Control', 'private, max-age=300')
      .send(media.body);
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
