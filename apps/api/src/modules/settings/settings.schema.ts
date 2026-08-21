import { z } from 'zod';
import {
  AI_ASSIST_MODES,
  BUSINESS_TYPES,
  DAYS_OF_WEEK,
  PAYMENT_METHODS,
  PRICING_STANCES,
  type AiAssistMode,
  type BusinessType,
  type DayOfWeek,
  type PaymentMethod,
  type PricingStance,
} from '@flowdesk/shared';
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

/** `"08:00"`. Rejected rather than coerced so a bad value never reaches a reply. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 08:00');

/** Money the assistant may quote. Bounded so a typo cannot become a quoted price. */
const cedis = z.number().nonnegative().max(1_000_000);

/**
 * The structured, checkable facts.
 *
 * Enums are derived from `@flowdesk/shared` rather than restated, so the wizard,
 * the validator and the database cannot disagree about what a valid answer is.
 * `.strict()` rejects unknown keys: a typo'd field would otherwise be stored,
 * never read, and quietly do nothing.
 */
export const BusinessProfileSchema = z
  .object({
    openingHours: z
      .object({
        days: z.array(z.enum(DAYS_OF_WEEK as unknown as [DayOfWeek, ...DayOfWeek[]])).max(7),
        opensAt: timeOfDay.nullable(),
        closesAt: timeOfDay.nullable(),
      })
      .strict()
      .optional(),
    deliveryAreas: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    deliveryFee: cedis.nullable().optional(),
    freeDeliveryAbove: cedis.nullable().optional(),
    minimumOrder: cedis.nullable().optional(),
    paymentMethods: z
      .array(z.enum(PAYMENT_METHODS as unknown as [PaymentMethod, ...PaymentMethod[]]))
      .max(PAYMENT_METHODS.length)
      .optional(),
    pricingStance: z
      .enum(PRICING_STANCES as unknown as [PricingStance, ...PricingStance[]])
      .optional(),
    acceptsReturns: z.boolean().optional(),
    returnWindowDays: z.number().int().nonnegative().max(365).nullable().optional(),
  })
  .strict();

export const UpdateBusinessSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    ownerName: z.string().trim().min(1).max(200).optional(),
    notifyOnNewOrder: z.boolean().optional(),
    notifyOnLowStock: z.boolean().optional(),
    notifyOnPayment: z.boolean().optional(),
    replyTemplates: ReplyTemplatesSchema.optional(),
    businessType: z
      .enum(BUSINESS_TYPES as unknown as [BusinessType, ...BusinessType[]])
      .nullable()
      .optional(),
    businessTypeOther: z.string().trim().max(120).nullable().optional(),
    /**
     * Merged into the stored profile rather than replacing it — see
     * `mergeBusinessProfile`. A wizard that saves one section at a time would
     * otherwise wipe every answer given in the others.
     */
    businessProfile: BusinessProfileSchema.nullable().optional(),
    businessPolicyNotes: z.string().trim().max(4000).nullable().optional(),
    aiAssistMode: z
      .enum(AI_ASSIST_MODES as unknown as [AiAssistMode, ...AiAssistMode[]])
      .optional(),
    /**
     * Whether this shop keeps a product list.
     *
     * Not derived from "is the catalogue empty" — a shop that has not added
     * products YET is not the same as a shop that never will, and guessing
     * wrong in either direction changes what every customer is told. The owner
     * says which they are.
     */
    catalogueMode: z.enum(['CATALOGUE', 'ENQUIRY_LED']).optional(),
  })
  .strict();

export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
export type ReplyTemplatesInput = z.infer<typeof ReplyTemplatesSchema>;
export type BusinessProfileInput = z.infer<typeof BusinessProfileSchema>;
