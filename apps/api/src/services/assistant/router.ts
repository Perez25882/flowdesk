import {
  IntentType,
  type AssistantAction,
  type AssistantDecision,
  type BusinessProfile,
  type ClarificationField,
} from '@flowdesk/shared';
import type { AiAssistMode, CatalogueMode } from '@prisma/client';
import { composeClarification, shouldStopClarifying } from './clarify.js';
import { composeEnquiryHold, isOwnerOnlyEnquiry } from './enquiry.js';
import { escalationRequired, isKnownEvidence } from './decision.js';
import type { EvidenceProduct, EvidenceSet } from './evidence.js';
import { assertsCheckableFact, validateGrounding, type GroundingFailure } from './grounding.js';

/**
 * What the server does with a decision.
 *
 * Pure, and separated from the worker for one reason: this is where auto-send is
 * granted. Every condition below has to be readable in one place and provable in
 * a test, because the cost of getting it wrong is a wrong price sent to a real
 * customer with nobody in the loop.
 *
 * The default is always the safe one. Anything this function is unsure about
 * becomes a draft, and a draft costs the owner a tap.
 */

/**
 * Below this the model is guessing, whatever the validator says. The validator
 * checks that figures are real, not that the right question was answered.
 */
const AUTO_SEND_CONFIDENCE = 0.8;

/**
 * Intents an unsupervised answer may be sent for.
 *
 * Deliberately short. These are the questions with a checkable answer sitting in
 * a table; everything else — payments, complaints, anything order-shaped — turns
 * on judgement or money changing hands, and goes to the owner.
 */
const AUTO_SENDABLE_INTENTS: ReadonlySet<IntentType> = new Set([
  IntentType.INQUIRY,
  IntentType.STATUS_CHECK,
]);

/**
 * Intents whose reply may be sent only while it asserts nothing checkable.
 *
 * A customer who says "good morning" and waits for the owner to approve
 * "morning!" has been served worse than by a shop with no software at all. The
 * reply is zero-risk precisely because there is nothing in it to be wrong
 * about — and the moment there is (a price, a stock level, an "we have that"),
 * `assertsCheckableFact` sends it down the normal grounded path instead.
 */
const SOCIAL_INTENTS: ReadonlySet<IntentType> = new Set([IntentType.GREETING]);

export interface RouteInput {
  mode: AiAssistMode;
  /**
   * Whether this shop keeps a product list. A shop that does not cannot have
   * its product questions answered from records that do not exist, so they are
   * held and handed to the owner instead of drafted into silence.
   */
  catalogueMode: CatalogueMode;
  decision: AssistantDecision | null;
  evidence: EvidenceSet;
  /** The catalogue rows rendered into the prompt, for composing a clarification. */
  products: EvidenceProduct[];
  profile: BusinessProfile | null;
  /** Escalation the server decided on its own, independent of the decision. */
  serverEscalation: boolean;
  /** How many times we have already asked this customer to clarify. */
  clarificationCount: number;
  /** False when the 24-hour service window has closed — nothing may be sent. */
  canDeliver: boolean;
  /** The customer's message, for composing a reply that names what they asked about. */
  message: string;
}

export interface RouteResult {
  action: AssistantAction;
  /** What to send or draft. Null for `template_reply` and `none`. */
  text: string | null;
  /** Why this is not being auto-sent, for the dashboard and for tuning. */
  validationFailures: GroundingFailure[];
  escalated: boolean;
  groundedOn: string[];
}

/** `product:<id>` / `fact:deliveryFee` — a flat form the message row can store. */
function serializeGroundedOn(decision: AssistantDecision): string[] {
  return decision.answer.groundedOn.map((ref) => {
    const prefix = ref.kind === 'business_fact' ? 'fact' : ref.kind;
    return ref.field ? `${prefix}:${ref.id}:${ref.field}` : `${prefix}:${ref.id}`;
  });
}

/** Stock of the products the answer actually cited — what the affirmation check needs. */
function citedStockLevels(decision: AssistantDecision, products: EvidenceProduct[]): number[] {
  const cited = new Set(
    decision.answer.groundedOn.filter((ref) => ref.kind === 'product').map((ref) => ref.id),
  );

  return products.filter((p) => cited.has(p.id)).map((p) => p.stockQuantity);
}

/**
 * The rows a clarification question should name.
 *
 * The model's product mentions come first — those are what the customer was
 * talking about. Falling back to everything rendered keeps the question useful
 * when the model flagged something missing without naming a product.
 */
function clarificationCandidates(
  decision: AssistantDecision,
  products: EvidenceProduct[],
): EvidenceProduct[] {
  const mentioned = new Set(
    decision.entities.products
      .map((mention) => mention.productId)
      .filter((id): id is string => id !== null),
  );

  const named = products.filter((p) => mentioned.has(p.id));
  return named.length > 0 ? named : products;
}

/**
 * Puts the missing fields in the order a person would ask them.
 *
 * The model reports what is missing but not what to ask first, and it will
 * happily pick a variant on the customer's behalf: "I want rice" at a shop with
 * two sizes came back as `missing: [quantity]` against Rice 25kg, so we would
 * have asked "how many Rice 25kg?" about a size nobody chose. Which one comes
 * before how many, whenever the message could still mean more than one product.
 */
function orderClarificationFields(
  decision: AssistantDecision,
  products: EvidenceProduct[],
): ClarificationField[] {
  const missing = [
    ...new Set([...deriveOrderGaps(decision, products), ...decision.clarification.missing]),
  ];

  // Nothing to ask. Returning early matters: the variant reorder below would
  // otherwise invent a question for a message that had none, which turned every
  // plain price enquiry at a shop with two sizes into "which one?".
  if (missing.length === 0) return [];

  if (!isVariantAmbiguous(decision, products)) return missing;

  return ['variant', ...missing.filter((field) => field !== 'variant')];
}

/** Whether this message is trying to buy something, by either reading of it. */
function isOrderShaped(decision: AssistantDecision): boolean {
  return decision.order.isOrder || decision.intent === IntentType.ORDER;
}

/**
 * What the server can see is missing, regardless of what the model reported.
 *
 * Holding an ambiguous order rather than inventing one is a product decision, so
 * it cannot rest on the model remembering to set `clarification.needed` — and in
 * live testing an 8B model set it for "I want rice" on one run and not the next.
 * The server has the catalogue in front of it and can work this out for itself:
 * an order needs one identified product and a quantity, and anything short of
 * that is a question, not an order.
 */
function deriveOrderGaps(
  decision: AssistantDecision,
  products: EvidenceProduct[],
): ClarificationField[] {
  if (!isOrderShaped(decision)) return [];

  // Nothing was retrieved, so there is no row to build a question from. Asking
  // "which one?" about an empty list is worse than handing it to the owner.
  if (products.length === 0) return [];

  if (isVariantAmbiguous(decision, products)) return ['variant'];

  const resolved = decision.entities.products.filter(
    (mention) => mention.productId !== null && products.some((p) => p.id === mention.productId),
  );

  // One product is in play; the only thing left that stops it being an order is
  // not knowing how many.
  return resolved.some((mention) => mention.quantity !== null) ? [] : ['quantity'];
}

/**
 * Whether the customer's own words still leave more than one product open.
 *
 * The test is the customer's wording, not the model's pick. Asked which product
 * "rice" meant, the model confidently answered Rice 25kg — so counting how many
 * ids it named would call that resolved and go straight to "how many Rice 25kg?".
 * Matching the mention against the retrieved rows asks the right question:
 * "rice" matches both sizes, "rice 5kg" matches one.
 */
function isVariantAmbiguous(decision: AssistantDecision, products: EvidenceProduct[]): boolean {
  if (products.length < 2) return false;

  const mention = decision.entities.products[0]?.mention.toLowerCase().trim();
  if (!mention) return true;

  const matches = products.filter((product) => product.name.toLowerCase().includes(mention));
  return matches.length !== 1;
}

/**
 * Whether this specific answer may go out unread.
 *
 * Every clause is a separate reason to stop, listed rather than collapsed so the
 * next person to widen the slice has to delete a line deliberately.
 */
function isAutoSendable(
  input: RouteInput,
  decision: AssistantDecision,
  failures: GroundingFailure[],
  escalated: boolean,
): boolean {
  if (input.mode !== 'GROUNDED_AUTO') return false;
  if (!input.canDeliver) return false;
  if (escalated) return false;
  if (failures.length > 0) return false;

  if (!decision.answer.canAnswer || !decision.answer.text) return false;
  if (decision.clarification.needed) return false;
  if (decision.confidence < AUTO_SEND_CONFIDENCE) return false;

  // A pleasantry that claims nothing is safe to send. Everything below this
  // point verifies assertions, and there are none to verify.
  if (isBarePleasantry(decision)) return true;

  if (!AUTO_SENDABLE_INTENTS.has(decision.intent)) return false;

  // Re-checked here even though the invariant pass already filtered them: this
  // is the line that turns a citation into permission to speak, so it verifies
  // rather than inherits. An answer resting on a row nobody supplied is not
  // grounded, however well it reads.
  if (decision.answer.groundedOn.length === 0) return false;
  if (!decision.answer.groundedOn.every((ref) => isKnownEvidence(ref, input.evidence))) {
    return false;
  }

  // An order is a commitment, not a question. It goes through order creation
  // with the owner able to see it, never through a chat reply.
  if (decision.order.isOrder) return false;

  // Product answers must be about one unambiguous product. "Rice is GHS 80"
  // when the shop sells two sizes of rice is wrong even though 80 is a real price.
  const citedProducts = new Set(
    decision.answer.groundedOn.filter((ref) => ref.kind === 'product').map((ref) => ref.id),
  );
  if (citedProducts.size > 1) return false;

  return true;
}

/**
 * A social reply with nothing in it to be wrong about.
 *
 * Both halves matter. The intent keeps this to greetings and thanks, and the
 * claim test keeps it honest when the model answers a greeting with a price
 * anyway — which it does, given a catalogue and an opening.
 */
function isBarePleasantry(decision: AssistantDecision): boolean {
  if (!SOCIAL_INTENTS.has(decision.intent)) return false;
  if (!decision.answer.text) return false;
  return !assertsCheckableFact(decision.answer.text);
}

export function routeDecision(input: RouteInput): RouteResult {
  const escalated = escalationRequired(input.decision, input.serverEscalation);

  // No decision: the assistant is off, unconfigured, or failed. The existing
  // template path still answers the customer, so the pipeline degrades rather
  // than going silent.
  if (!input.decision || input.mode === 'OFF') {
    return {
      action: 'template_reply',
      text: null,
      validationFailures: [],
      escalated,
      groundedOn: [],
    };
  }

  const decision = input.decision;
  const groundedOn = serializeGroundedOn(decision);

  // Asking beats answering: a question we composed ourselves from real rows is
  // safe to send even when the model could not produce a grounded answer.
  //
  // The trigger is the server's own reading OR the model's, never the model's
  // alone — an order the server cannot build is an order that has to be asked
  // about, whatever the decision claimed.
  const missing = orderClarificationFields(decision, input.products);
  const mustAsk = decision.clarification.needed || missing.length > 0;

  if (mustAsk && !shouldStopClarifying(input.clarificationCount)) {
    // A variant question is about the whole set of options, so it must not be
    // narrowed to the one product the model happened to pick — that leaves a
    // single candidate and no choice to offer.
    const candidates =
      missing[0] === 'variant'
        ? input.products
        : clarificationCandidates(decision, input.products);

    const question = composeClarification(missing, {
      candidates,
      mention: decision.entities.products[0]?.mention ?? null,
      profile: input.profile,
    });

    if (question && input.canDeliver && !escalated) {
      return { action: 'clarify', text: question, validationFailures: [], escalated, groundedOn };
    }
  }

  // A shop with no product list cannot answer "do you have baggy jeans?" from
  // anything, and neither can the assistant. Rather than falling through to a
  // generic template — which tells the customer nothing and tells the owner
  // nothing either — hold the customer with a reply that names what they asked
  // about, and escalate so the owner is asked the one question only they can
  // answer.
  //
  // Escalated on purpose: this is not the assistant answering, it is the
  // assistant buying the owner a minute. The message lands in the review queue
  // either way.
  if (input.catalogueMode === 'ENQUIRY_LED' && isOwnerOnlyEnquiry(decision)) {
    const hold = composeEnquiryHold({ decision, message: input.message });

    if (hold && input.canDeliver) {
      return {
        action: 'clarify',
        text: hold,
        validationFailures: [],
        escalated: true,
        groundedOn,
      };
    }

    // Cannot say anything safely, or cannot send at all. Still escalate — a
    // silent drop is the one outcome that loses the sale without telling
    // anybody.
    return {
      action: 'template_reply',
      text: null,
      validationFailures: [],
      escalated: true,
      groundedOn,
    };
  }

  // Nothing to say. The template still goes out so the customer is not ignored.
  if (!decision.answer.text) {
    return {
      action: 'template_reply',
      text: null,
      validationFailures: [],
      escalated,
      groundedOn,
    };
  }

  const validation = validateGrounding({
    text: decision.answer.text,
    evidence: input.evidence,
    groundedOn: decision.answer.groundedOn.map((ref) => ref.id),
    citedStock: citedStockLevels(decision, input.products),
    // A greeting has no row behind it. Requiring one turned every "Morning!"
    // into something the owner had to approve, which is worse service than
    // having no assistant at all.
    requireCitation: !isBarePleasantry(decision),
  });

  if (isAutoSendable(input, decision, validation.failures, escalated)) {
    return {
      action: 'auto_send',
      text: decision.answer.text,
      validationFailures: [],
      escalated,
      groundedOn,
    };
  }

  // The text is still worth keeping: an owner editing a nearly-right reply is
  // the whole point of drafting, and a failed check tells them where to look.
  return {
    action: 'draft',
    text: decision.answer.text,
    validationFailures: validation.failures,
    escalated,
    groundedOn,
  };
}

/**
 * Whether the owner has to look at this message.
 *
 * Reworked from a flat intent list. Flagging every INQUIRY made sense when the
 * only reply was "please share more details" — the owner had to answer it
 * themselves. Now an answered inquiry is finished work, and leaving it in the
 * queue trains owners to stop reading the queue, which is what the drafting
 * workflow depends on.
 */
export function requiresReview(
  intent: IntentType,
  confidence: number,
  action: AssistantAction,
  escalated: boolean,
): boolean {
  if (escalated) return true;
  if (intent === IntentType.UNCLASSIFIED) return true;
  if (confidence < 0.6) return true;

  switch (action) {
    // Handled, and handled verifiably.
    case 'auto_send':
    case 'clarify':
      return false;
    // Waiting on the owner by definition.
    case 'draft':
      return true;
    // The assistant did not run. Fall back to the intents a person has always
    // had to deal with themselves.
    case 'template_reply':
    case 'none':
    default:
      return (
        intent === IntentType.COMPLAINT ||
        intent === IntentType.INQUIRY ||
        intent === IntentType.PAYMENT
      );
  }
}
