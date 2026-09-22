import {
  ASSISTANT_CONTRACT_VERSION,
  ASSISTANT_LANGUAGES,
  ASSISTANT_SENTIMENTS,
  CLARIFICATION_FIELDS,
  ESCALATION_REASONS,
  IntentType,
  type AssistantDecision,
  type AssistantEvidenceRef,
  type AssistantProductMention,
} from '@flowdesk/shared';
import { z } from 'zod';
import type { EvidenceSet } from './evidence.js';
import { MAX_QUANTITY } from '../../utils/item-extractor.js';

/**
 * Turning the model's JSON into a decision the server is willing to act on.
 *
 * Two separate jobs, deliberately kept apart:
 *
 *   1. `parseDecision` — is this even the right shape? Structured output makes
 *      malformed JSON unlikely, not impossible, and a provider outage can return
 *      something else entirely.
 *   2. `applyServerInvariants` — is it self-consistent, and is it citing evidence
 *      that actually exists? A model that invents a product id would otherwise be
 *      citing evidence into existence, and `groundedOn` is the thing the auto-send
 *      gate keys on. This step is what makes `groundedOn` a hint rather than a grant.
 */

/** Intents the model may return. `UNCLASSIFIED` is a server-side outcome, not a choice. */
const MODEL_INTENTS = [
  IntentType.ORDER,
  IntentType.PAYMENT,
  IntentType.INQUIRY,
  IntentType.STATUS_CHECK,
  IntentType.COMPLAINT,
  IntentType.GREETING,
  IntentType.OTHER,
] as const;

/**
 * Caps on every array the model controls.
 *
 * Not validation so much as blast radius: a response that lists two hundred
 * product mentions costs downstream queries and clarification attempts for no
 * benefit, and nothing legitimate needs more than a handful.
 */
const MAX_PRODUCT_MENTIONS = 10;
const MAX_GROUNDED_REFS = 12;
const MAX_ORDER_REFERENCES = 5;
const MAX_MISSING_FIELDS = CLARIFICATION_FIELDS.length;

/** Longer than any reply we would send on WhatsApp; a longer one is a runaway. */
const MAX_ANSWER_LENGTH = 1_000;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

/**
 * The schema the API constrains generation to.
 *
 * Hand-written rather than derived from the Zod schema below: structured outputs
 * reject `minimum`/`maxLength`-style constraints, and every object needs
 * `additionalProperties: false` with every property listed in `required`. Keeping
 * the two definitions side by side in one file is what stops them drifting.
 */
export const ASSISTANT_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'confidence',
    'language',
    'sentiment',
    'entities',
    'answer',
    'clarification',
    'order',
    'escalate',
    'priceOffer',
    'booking',
  ],
  properties: {
    intent: { type: 'string', enum: [...MODEL_INTENTS] },
    confidence: { type: 'number', description: 'Between 0 and 1.' },
    language: { type: 'string', enum: [...ASSISTANT_LANGUAGES] },
    sentiment: { type: 'string', enum: [...ASSISTANT_SENTIMENTS] },
    entities: {
      type: 'object',
      additionalProperties: false,
      required: ['products', 'orderReferences', 'deliveryArea'],
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['productId', 'mention', 'quantity'],
            properties: {
              productId: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
                description: 'A catalogue id from the prompt, or null if nothing matched.',
              },
              mention: {
                type: 'string',
                description: "The customer's own words for the product.",
              },
              quantity: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
        },
        orderReferences: { type: 'array', items: { type: 'string' } },
        deliveryArea: nullableString,
      },
    },
    answer: {
      type: 'object',
      additionalProperties: false,
      required: ['canAnswer', 'text', 'groundedOn'],
      properties: {
        canAnswer: {
          type: 'boolean',
          description:
            'True only if this answer is safe to send with nobody checking it first.',
        },
        text: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          // Guided decoding follows this description, so it has to agree with the
          // system prompt. It used to say "null when you cannot answer", which
          // meant every escalated message reached the owner with nothing to edit.
          description:
            'Your suggested reply. Always write one, even when canAnswer is false or you are escalating — it is shown to the shop owner to edit. Null only if you truly have nothing to suggest.',
        },
        groundedOn: {
          type: 'array',
          description: 'Every row this answer rests on. An empty list discards the answer.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id', 'field'],
            properties: {
              kind: { type: 'string', enum: ['product', 'business_fact', 'order'] },
              id: {
                type: 'string',
                description: 'A product id, order id, or business-fact key from the prompt.',
              },
              field: nullableString,
            },
          },
        },
      },
    },
    clarification: {
      type: 'object',
      additionalProperties: false,
      required: ['needed', 'missing'],
      properties: {
        needed: { type: 'boolean' },
        missing: {
          type: 'array',
          items: { type: 'string', enum: [...CLARIFICATION_FIELDS] },
        },
      },
    },
    order: {
      type: 'object',
      additionalProperties: false,
      required: ['isOrder', 'complete'],
      properties: {
        isOrder: { type: 'boolean' },
        complete: { type: 'boolean' },
      },
    },
    escalate: {
      type: 'object',
      additionalProperties: false,
      required: ['needed', 'reason'],
      properties: {
        needed: { type: 'boolean' },
        reason: {
          anyOf: [{ type: 'string', enum: [...ESCALATION_REASONS] }, { type: 'null' }],
        },
      },
    },
    // A negotiated price has to be DECLARED, not merely written in the reply.
    // Reading a discount back out of "okay, GHS 40 then" means parsing prose to
    // decide what the shop just committed to, and prose is exactly what the
    // model controls. Asking for the number as a field moves the check to
    // arithmetic the server does on a value the model had to state plainly.
    priceOffer: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['productId', 'unitPrice', 'quantity'],
          properties: {
            productId: { type: 'string', description: 'The catalogue id being priced.' },
            unitPrice: {
              type: 'number',
              description: 'The price per unit you are offering, in cedis.',
            },
            quantity: { type: 'number', description: 'How many, at that price.' },
          },
        },
        { type: 'null' },
      ],
      description:
        'Set this ONLY when your reply offers a price below the one you were shown. Null otherwise.',
    },
    // A time, declared rather than left in the sentence, for exactly the same
    // reason as the price. An appointment that exists only in prose is one the
    // server cannot check and will not write into the diary, so the customer
    // gets a confirmation and the owner gets nothing.
    booking: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['serviceId', 'startsAt'],
          properties: {
            serviceId: { type: 'string', description: 'The service id from AVAILABLE TIMES.' },
            startsAt: {
              type: 'string',
              description: 'One of the exact times listed for that service, copied unchanged.',
            },
          },
        },
        { type: 'null' },
      ],
      description:
        'Set this ONLY when your reply agrees a specific appointment time. Null otherwise.',
    },
  },
};

const evidenceRefSchema = z.object({
  kind: z.enum(['product', 'business_fact', 'order']),
  id: z.string(),
  field: z.string().nullish(),
});

const productMentionSchema = z.object({
  productId: z.string().nullish(),
  mention: z.string(),
  quantity: z.number().nullish(),
});

/**
 * Deliberately more forgiving than the schema the model was given.
 *
 * The schema asks for every field; this accepts a decision that leaves the empty
 * ones out. Open models routinely omit `"products": []` and `"orderReferences":
 * []`, and rejecting an otherwise perfect answer over two absent empty arrays is
 * the "reject correct answers" failure — the feature silently drafting
 * everything while appearing to work. A live probe did exactly that to a correct
 * delivery-fee answer.
 *
 * Permissiveness here is safe because it cannot manufacture anything: a missing
 * array becomes empty, and empty evidence means the answer is not sendable. The
 * invariant pass, the validator and the router all still run afterwards.
 */
const decisionSchema = z.object({
  intent: z.enum(MODEL_INTENTS),
  // Absent confidence reads as no confidence, which fails the auto-send bar.
  confidence: z.number().default(0),
  language: z.enum(ASSISTANT_LANGUAGES).default('other'),
  sentiment: z.enum(ASSISTANT_SENTIMENTS).default('neutral'),
  entities: z
    .object({
      products: z.array(productMentionSchema).default([]),
      orderReferences: z.array(z.string()).default([]),
      deliveryArea: z.string().nullish(),
    })
    .default({}),
  answer: z
    .object({
      canAnswer: z.boolean().default(false),
      text: z.string().nullish(),
      groundedOn: z.array(evidenceRefSchema).default([]),
    })
    .default({}),
  clarification: z
    .object({
      needed: z.boolean().default(false),
      missing: z.array(z.enum(CLARIFICATION_FIELDS)).default([]),
    })
    .default({}),
  order: z
    .object({
      isOrder: z.boolean().default(false),
      complete: z.boolean().default(false),
    })
    .default({}),
  escalate: z
    .object({
      needed: z.boolean().default(false),
      reason: z.enum(ESCALATION_REASONS).nullish(),
    })
    .default({}),
  priceOffer: z
    .object({
      productId: z.string(),
      unitPrice: z.number(),
      quantity: z.number(),
    })
    .nullish(),
  booking: z
    .object({
      serviceId: z.string(),
      startsAt: z.string(),
    })
    .nullish(),
});

/** Parses the model's JSON. Returns null rather than throwing — a bad response is expected traffic. */
export function parseDecision(raw: unknown): AssistantDecision | null {
  const result = decisionSchema.safeParse(raw);
  if (!result.success) return null;

  const value = result.data;

  return {
    version: ASSISTANT_CONTRACT_VERSION,
    intent: value.intent,
    confidence: value.confidence,
    language: value.language,
    sentiment: value.sentiment,
    entities: {
      products: value.entities.products.map((p) => ({
        productId: p.productId ?? null,
        mention: p.mention,
        quantity: p.quantity ?? null,
      })),
      orderReferences: value.entities.orderReferences,
      deliveryArea: value.entities.deliveryArea ?? null,
    },
    answer: {
      canAnswer: value.answer.canAnswer,
      text: value.answer.text ?? null,
      groundedOn: value.answer.groundedOn.map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        ...(ref.field ? { field: ref.field } : {}),
      })),
    },
    clarification: value.clarification,
    order: value.order,
    escalate: {
      needed: value.escalate.needed,
      reason: value.escalate.reason ?? null,
    },
    priceOffer: value.priceOffer
      ? {
          productId: value.priceOffer.productId,
          unitPrice: value.priceOffer.unitPrice,
          quantity: value.priceOffer.quantity,
        }
      : null,
    booking: value.booking
      ? { serviceId: value.booking.serviceId, startsAt: value.booking.startsAt }
      : null,
  };
}

/**
 * Whether a cited id is one the server actually put in the prompt.
 *
 * Exported because the router checks it again before granting auto-send. That is
 * duplicated work by design: "`groundedOn` is a hint, never a grant" has to hold
 * at the point the grant is made, not rely on an earlier pass having run.
 */
export function isKnownEvidence(ref: AssistantEvidenceRef, evidence: EvidenceSet): boolean {
  switch (ref.kind) {
    case 'product':
      return evidence.productIds.has(ref.id);
    case 'business_fact':
      return evidence.factKeys.has(ref.id);
    case 'order':
      return evidence.orderIds.has(ref.id) || evidence.allowedOrderRefs.has(ref.id.toUpperCase());
    default:
      return false;
  }
}

function dedupeRefs(refs: AssistantEvidenceRef[]): AssistantEvidenceRef[] {
  const seen = new Set<string>();
  const out: AssistantEvidenceRef[] = [];

  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}:${ref.field ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }

  return out;
}

function normalizeMention(
  mention: AssistantProductMention,
  evidence: EvidenceSet,
): AssistantProductMention {
  // The same ceiling the deterministic extractor applies, imported rather than
  // restated so the two order paths cannot drift apart. Without it the model
  // could put an arbitrary quantity on a line: `totalAmount` is Decimal(12,2),
  // so a large enough quantity times a real price either overflows the column
  // and throws inside the worker, or lands a multi-billion-cedi order in the
  // owner's queue and, once confirmed, on the customer's balance.
  const quantity =
    mention.quantity !== null && Number.isFinite(mention.quantity) && mention.quantity > 0
      ? Math.min(Math.round(mention.quantity), MAX_QUANTITY)
      : null;

  return {
    // The mention text survives an unknown id — it is what the clarification
    // question is built from, and "we don't stock that" is a useful answer.
    productId:
      mention.productId && evidence.productIds.has(mention.productId) ? mention.productId : null,
    mention: mention.mention.slice(0, 120),
    quantity,
  };
}

/**
 * Brings the decision back inside what the server is prepared to believe.
 *
 * Every rule here exists because the alternative is a self-granted answer: the
 * model deciding on its own that it may speak, or citing a row that was never
 * supplied. None of them can be relaxed by the model's own output.
 *
 * Note what is NOT here: escalation. `escalate.needed: false` must never clear a
 * server-side escalation, so the two are OR-ed by the caller — see
 * `escalationRequired`.
 */
export function applyServerInvariants(
  decision: AssistantDecision,
  evidence: EvidenceSet,
): AssistantDecision {
  const groundedOn = dedupeRefs(
    decision.answer.groundedOn.filter((ref) => isKnownEvidence(ref, evidence)),
  ).slice(0, MAX_GROUNDED_REFS);

  const text = decision.answer.text?.trim() ?? '';

  // An answer may only be considered sendable when it rests on something real,
  // actually says something, and is not simultaneously a question.
  const canAnswer =
    decision.answer.canAnswer &&
    groundedOn.length > 0 &&
    text.length > 0 &&
    text.length <= MAX_ANSWER_LENGTH &&
    !decision.clarification.needed;

  return {
    ...decision,
    confidence: Math.min(1, Math.max(0, decision.confidence)),
    entities: {
      products: decision.entities.products
        .slice(0, MAX_PRODUCT_MENTIONS)
        .map((mention) => normalizeMention(mention, evidence)),
      orderReferences: [...new Set(decision.entities.orderReferences.map((r) => r.toUpperCase()))]
        .filter((ref) => evidence.allowedOrderRefs.has(ref))
        .slice(0, MAX_ORDER_REFERENCES),
      deliveryArea: decision.entities.deliveryArea?.trim() || null,
    },
    answer: {
      canAnswer,
      text: text.length > 0 ? text : null,
      groundedOn,
    },
    clarification: {
      needed: decision.clarification.needed,
      missing: [...new Set(decision.clarification.missing)].slice(0, MAX_MISSING_FIELDS),
    },
    order: {
      isOrder: decision.order.isOrder,
      // An order cannot be complete while we are still asking about it.
      complete: decision.order.complete && !decision.clarification.needed,
    },
  };
}

/**
 * Whether a human has to see this.
 *
 * OR, never AND: the model may ask for a person, but it may not decide it does
 * not need one. A message that reaches the server's own escalation rules is
 * escalated whatever the decision says.
 *
 * A missing decision is deliberately NOT an escalation. It was, briefly, on the
 * reasoning that an outage should not read as "nothing needed a human today" —
 * but a shop with no API key configured then had every greeting flagged, which
 * is the queue-flooding this rework exists to stop. Messages that genuinely need
 * a person when the assistant is silent are caught by `requiresReview`'s
 * fallback branch instead, which is the same rule that applied before it existed.
 */
export function escalationRequired(
  decision: AssistantDecision | null,
  serverEscalation: boolean,
): boolean {
  return serverEscalation || (decision?.escalate.needed ?? false);
}
