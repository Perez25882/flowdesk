import { z } from 'zod';
import {
  AI_ASSIST_MODES,
  BUSINESS_TYPES,
  DAYS_OF_WEEK,
  GHANA_REGIONS,
  PAYMENT_METHODS,
  PRICING_STANCES,
  type AiAssistMode,
  type BusinessType,
  type DayOfWeek,
  type GhanaRegion,
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
    deliveryZones: z
      .array(
        z
          .object({
            region: z.enum(GHANA_REGIONS as unknown as [GhanaRegion, ...GhanaRegion[]]),
            town: z.string().trim().min(1).max(80),
            area: z.string().trim().max(80).nullable().optional(),
            fee: cedis,
            eta: z.string().trim().max(60).nullable().optional(),
          })
          .strict(),
      )
      // Generous, because a shop that delivers across Accra genuinely has
      // dozens of zones, and bounded, because the whole list is rendered into
      // every prompt and an unbounded one would eventually cost more in tokens
      // than the answer is worth.
      .max(200)
      .optional(),
    /**
     * A map link or a Ghana Post GPS code.
     *
     * Restricted to http(s) and the GhanaPost format so the assistant can never
     * be handed a `javascript:` or `data:` URL to put in front of a customer —
     * the owner types this, but an owner is exactly who a social-engineering
     * attempt targets.
     */
    locationUrl: z
      .string()
      .trim()
      .max(500)
      .refine(
        (value) =>
          value.length === 0 ||
          /^https?:\/\//i.test(value) ||
          /^[A-Z]{2}-\d{3,4}-\d{3,4}$/i.test(value),
        { message: 'Use a link starting with https:// or a GhanaPost code like GA-123-4567' },
      )
      .nullable()
      .optional(),
    locationDescription: z.string().trim().max(300).nullable().optional(),
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
    /** Send the customer a receipt when a payment confirms. */
    receiptsEnabled: z.boolean().optional(),
    /** Write the owner a summary of yesterday each morning. */
    insightsEnabled: z.boolean().optional(),
    /** Also send that summary to the owner's phone on WhatsApp. */
    insightsToWhatsApp: z.boolean().optional(),
    /**
     * Whether the assistant may haggle at all.
     *
     * On its own this changes nothing: a product with no floor price still has
     * exactly one price. It is the switch that makes the per-product floors
     * take effect, so an owner can stop all negotiation everywhere in one tap
     * without having to unpick every product they set up.
     */
    bargainingEnabled: z.boolean().optional(),
    /**
     * Whether this business takes appointments.
     *
     * Off by default. It adds a nav item, a diary and a section to every
     * assistant prompt, none of which a shop selling bags has any use for.
     */
    bookingsEnabled: z.boolean().optional(),
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

/**
 * How many days of insight to return.
 *
 * `GET /insights` was the one new route parsing its query by hand. The service
 * bounded it with `Math.min(limit, 90)`, which caps the top and says nothing
 * about the bottom, so `?limit=-999999` arrived at Prisma as a negative `take`
 * — which Postgres reads as "from the end", scanning the lot.
 *
 * Bounded here instead, for the same reason every other route in this codebase
 * validates its query with a schema: a boundary enforced in one obvious place
 * cannot be half-enforced in two.
 */
export const InsightsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(90).default(14),
});

export type InsightsQueryInput = z.infer<typeof InsightsQuerySchema>;

export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
export type ReplyTemplatesInput = z.infer<typeof ReplyTemplatesSchema>;
export type BusinessProfileInput = z.infer<typeof BusinessProfileSchema>;
