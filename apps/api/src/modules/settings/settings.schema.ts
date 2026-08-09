import { z } from 'zod';
import { TEMPLATE_KEYS, type TemplateKey } from '../../services/templates/template-engine.js';

/**
 * Auto-reply configuration.
 *
 * The keys here are the SAME `TemplateKey` values the reply engine reads. An
 * earlier version defined its own camelCase key set (`orderReceived`, …) while
 * the engine read snake_case (`order_pending`, …), so every customisation an
 * owner saved was silently ignored. Deriving the enum from the engine makes
 * that class of drift impossible.
 */
const templateKeyEnum = z.enum(TEMPLATE_KEYS as [TemplateKey, ...TemplateKey[]]);

export const ReplyTemplatesSchema = z
  .object({
    /** Replacement wording, keyed by template. Omit a key to keep the default. */
    overrides: z.record(templateKeyEnum, z.string().min(1).max(1024)).optional(),
    /** Templates the owner has switched off entirely. */
    disabled: z.array(templateKeyEnum).optional(),
  })
  .strict()
  .nullable();

export const UpdateBusinessSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    ownerName: z.string().trim().min(1).max(200).optional(),
    notifyOnNewOrder: z.boolean().optional(),
    notifyOnLowStock: z.boolean().optional(),
    notifyOnPayment: z.boolean().optional(),
    replyTemplates: ReplyTemplatesSchema.optional(),
  })
  .strict();

export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
export type ReplyTemplatesInput = z.infer<typeof ReplyTemplatesSchema>;
