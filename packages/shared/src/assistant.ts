import type { IntentType } from './intent.js';

/**
 * What the assistant returns for one message.
 *
 * The model returns a DECISION, not a label and not a finished action. The
 * server decides what actually happens: the model's own `canAnswer` and
 * `escalate: false` are treated as suggestions, never as permission. Everything
 * here is checked against the evidence the server itself supplied before any of
 * it reaches a customer.
 */

export const ASSISTANT_CONTRACT_VERSION = 1;

/**
 * The register the customer wrote in, so the reply can match it.
 * Ghanaian trade runs across all of these, often inside one message.
 */
export const ASSISTANT_LANGUAGES = ['en', 'gh_en', 'pidgin', 'twi_mix', 'other'] as const;
export type AssistantLanguage = (typeof ASSISTANT_LANGUAGES)[number];

export const ASSISTANT_SENTIMENTS = ['neutral', 'unhappy', 'angry'] as const;
export type AssistantSentiment = (typeof ASSISTANT_SENTIMENTS)[number];

/**
 * Something the answer claims to rest on.
 *
 * A routing HINT, never a grant: the server verifies every id against the set it
 * put in the prompt, because a model that invents an id would otherwise be
 * citing evidence into existence.
 */
export interface AssistantEvidenceRef {
  kind: 'product' | 'business_fact' | 'order';
  /** Product id, order id, or a fact key such as `deliveryFee`. */
  id: string;
  /** Which attribute was used — `price`, `stockQuantity`, `status`. */
  field?: string;
}

/** Why the assistant wants a human. `needed: true` is always honoured. */
export const ESCALATION_REASONS = [
  'complaint',
  'bargaining',
  'unknown_fact',
  'low_confidence',
  'policy',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** What is missing before an order can be created. Drives the question we ask. */
export const CLARIFICATION_FIELDS = [
  'quantity',
  'variant',
  'delivery_area',
  'payment_method',
  'address',
] as const;
export type ClarificationField = (typeof CLARIFICATION_FIELDS)[number];

export interface AssistantProductMention {
  /** Must be an id the server supplied. Null when nothing in the catalogue matched. */
  productId: string | null;
  /** The customer's own words for it, for the clarification question. */
  mention: string;
  quantity: number | null;
}

export interface AssistantDecision {
  version: typeof ASSISTANT_CONTRACT_VERSION;
  intent: IntentType;
  confidence: number;
  language: AssistantLanguage;
  sentiment: AssistantSentiment;
  entities: {
    products: AssistantProductMention[];
    orderReferences: string[];
    deliveryArea: string | null;
  };
  answer: {
    canAnswer: boolean;
    text: string | null;
    groundedOn: AssistantEvidenceRef[];
  };
  clarification: {
    needed: boolean;
    /**
     * What is missing. The server composes the question itself from this and
     * the real catalogue rows — the model's own wording is never sent, because
     * it is the one channel where unchecked model output would reach a customer
     * and could be steered by the message it is replying to.
     */
    missing: ClarificationField[];
  };
  order: {
    isOrder: boolean;
    /** False when something needed to price or fulfil it is missing. */
    complete: boolean;
  };
  escalate: {
    needed: boolean;
    reason: EscalationReason | null;
  };
  /**
   * A price below the one the model was shown, stated as a number rather than
   * left in the prose.
   *
   * Null in the overwhelming majority of replies. When it is set, the server
   * checks it against the product's floor and refuses the whole reply if it is
   * under — which is why it must be declared: a discount that only exists in a
   * sentence is a discount the server cannot check before the customer reads it.
   */
  priceOffer: {
    productId: string;
    unitPrice: number;
    quantity: number;
  } | null;
  /**
   * A time the reply just agreed to, stated as data rather than left in prose.
   *
   * Null in almost every reply. When it is set, the server checks the instant
   * against the free slots it computed BEFORE the model ran, and refuses the
   * whole reply if it is not one of them — which is why it has to be declared.
   * An appointment that exists only inside a sentence is one that nothing can
   * check and nothing will write down.
   */
  booking: {
    serviceId: string;
    /** ISO 8601, exactly one of the times the prompt offered. */
    startsAt: string;
  } | null;
}

/** What the server decided to do, after checking the decision. */
export const ASSISTANT_ACTIONS = [
  'auto_send',
  'clarify',
  'draft',
  'template_reply',
  'none',
] as const;
export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];
