import {
  IntentType,
  type AssistantAction,
  type AssistantDecision,
  type BusinessProfile,
  type ClarificationField,
} from '@flowdesk/shared';
import type { AiAssistMode, CatalogueMode } from '@prisma/client';
import { composeClarification, shouldStopClarifying } from './clarify.js';
import { composeEnquiryHold, composeHold, isOwnerOnlyEnquiry } from './enquiry.js';
import { escalationRequired, isKnownEvidence } from './decision.js';
import { offerIsAuthorised } from '../pricing/ladder.js';
import { bookingOfferStatus } from './booking-offer.js';
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

/*
 * There is no longer an intent allow-list.
 *
 * It used to hold INQUIRY and STATUS_CHECK, on the reasoning that everything
 * else turns on judgement or money. In practice it was the wrong axis: a
 * customer saying "alright, thanks" is not a money question, and neither is
 * "no, we don't sell corporate attire", yet both were routed to the owner for
 * approval because their intent was not on the list.
 *
 * What decides safety is what the reply CLAIMS, not what the message was about,
 * and that is now checked directly — see `isAutoSendable`. Orders and anything
 * the model escalates still stop, and every figure is still verified against
 * the catalogue.
 */

/**
 * The claim-free exemption is no longer scoped to social intents.
 *
 * A customer who says "good morning" and waits for the owner to approve
 * "morning!" has been served worse than by a shop with no software at all. That
 * was the original reason for this set — but the same is true of "we don't sell
 * that" and "alright, anytime", which are not greetings and were being held
 * anyway. The reply is zero-risk precisely because there is nothing in it to be
 * wrong about, and that is a property of the SENTENCE, not of the intent that
 * produced it. `assertsCheckableFact` now decides on its own; the moment a reply
 * carries a price, a stock level or a "we have that", it goes down the normal
 * grounded path instead.
 */

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

/**
 * A price the shop authorised in advance, ready to be billed.
 *
 * Carried on the route rather than recomputed downstream so that the decision
 * which gates the REPLY and the decision which prices the ORDER are the same
 * decision. They used to be two, and only one of them existed: the reply was
 * checked against the floor, the order was raised at list price, and a shop
 * with bargaining on would promise GHS 40 in writing and invoice GHS 50.
 */
export interface AuthorisedPriceOffer {
  productId: string;
  unitPrice: number;
  quantity: number;
}

/**
 * A time the server confirmed is free, ready to be taken.
 *
 * Carried for the same reason as the price: the gate that decides the reply may
 * be sent and the write that makes it true must be one decision. They were two,
 * and the second did not exist — the assistant could confirm a slot and write
 * nothing.
 */
export interface AuthorisedBooking {
  serviceId: string;
  /** ISO-8601 instant, exactly as the slot gate checked it. */
  startsAt: string;
}

export interface RouteResult {
  action: AssistantAction;
  /** What to send or draft. Null for `template_reply` and `none`. */
  text: string | null;
  /**
   * The agreed price to bill, or null when nothing was negotiated.
   *
   * Non-null ONLY when `priceOfferStatus` returned `authorised` — the model
   * declared a price and the server checked it against a ladder it computed
   * itself. A refused offer leaves this null and the order falls back to the
   * shelf price, which is also what happens for every shop that has not
   * switched bargaining on.
   */
  authorisedPriceOffer: AuthorisedPriceOffer | null;
  /**
   * The slot to take, or null when no booking was confirmed.
   *
   * Non-null ONLY when `bookingOfferStatus` returned `authorised`. The caller
   * must write it before sending the reply, and must not send the reply if the
   * write fails.
   */
  authorisedBooking: AuthorisedBooking | null;
  /**
   * What to say to the customer while the owner works on the draft.
   *
   * A draft leaves the customer waiting, so the worker sends something in the
   * meantime. That used to be a fixed template — "Thanks for your question.
   * Please share more details and we'll get back to you right away" — which
   * asks a customer who has just asked a clear question to ask it again, and
   * reads as a form letter because it is one. This names what they actually
   * asked about instead. Null when nothing safe can be composed, in which case
   * the worker falls back to the template.
   */
  holdingText: string | null;
  /**
   * A product photo to send with the reply, or null.
   *
   * Decided here rather than by the model. The model is told only that a photo
   * exists; which bytes get attached is a server decision, because a model that
   * could name an image id would eventually name one belonging to another shop.
   */
  photoImageId: string | null;
  /**
   * A link the SERVER appends after the reply, or null.
   *
   * The grounding validator refuses any auto-sent text containing a URL, and
   * that rule stays — a model that can type a link is a model that can type a
   * wrong one into a customer's chat. This is the narrow exception: a value the
   * owner saved, validated as http(s) or a GhanaPost code when it was saved,
   * attached by the server to a reply that already passed every check without
   * it.
   */
  appendLink: string | null;
  /** Why this is not being auto-sent, for the dashboard and for tuning. */
  validationFailures: GroundingFailure[];
  escalated: boolean;
  groundedOn: string[];
}

/**
 * How a Ghanaian customer asks to see the thing.
 *
 * Deliberately a keyword test rather than a model decision. Attaching a photo
 * is irreversible in the way everything on WhatsApp is irreversible, and a
 * pattern list is something the owner's own messages can be checked against —
 * "send am make I see" and "how e dey look" are as common here as "send a
 * picture", and a rule that only spoke English would serve half the market.
 */
const PHOTO_REQUEST_PATTERN =
  /\b(pic|pics|picture|pictures|photo|photos|foto|image|images|snap|snaps)\b|\bsend\s+am\b|\blet\s+me\s+see\b|\bmake\s+i\s+see\b|\bhow\s+(it|e|dem)\s+(look|dey\s+look|be)\b|\bshow\s+me\b|\bany\s+sample\b/i;

export function customerAskedForPhoto(message: string): boolean {
  return PHOTO_REQUEST_PATTERN.test(message);
}

/**
 * The photo to attach, if any.
 *
 * Three conditions, all required. The customer has to have asked — a shop that
 * volunteers pictures nobody wanted is a shop being muted. The reply has to
 * rest on exactly one product, because a picture is an unambiguous claim about
 * a single item and sending one alongside an answer covering two is a wrong
 * answer with a photograph attached. And that product has to actually have a
 * photo on file.
 */
function selectPhoto(
  decision: AssistantDecision,
  products: EvidenceProduct[],
  message: string,
): string | null {
  if (!customerAskedForPhoto(message)) return null;

  const citedIds = new Set(
    decision.answer.groundedOn.filter((ref) => ref.kind === 'product').map((ref) => ref.id),
  );
  if (citedIds.size !== 1) return null;

  const [productId] = [...citedIds];
  const product = products.find((candidate) => candidate.id === productId);

  return product?.photoId ?? null;
}

/**
 * The map link, when the reply is actually about where the shop is.
 *
 * Gated on the model having cited `locationUrl`, not on a keyword: the citation
 * is the model saying "this answer rests on the shop's location", and appending
 * a map link to an answer about delivery charges would be noise at best.
 */
function selectLocationLink(
  decision: AssistantDecision,
  profile: BusinessProfile | null,
): string | null {
  if (!profile?.locationUrl) return null;

  const citesLocation = decision.answer.groundedOn.some(
    (ref) => ref.kind === 'business_fact' && ref.id === 'locationUrl',
  );

  return citesLocation ? profile.locationUrl : null;
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
/**
 * Whether this shop has handed the conversation over entirely.
 *
 * In AUTONOMOUS mode the assistant answers whether or not the answer can be
 * checked against a record. That is the owner's decision to make and it is
 * recorded before the mode can be entered — but it is worth being exact about
 * what it changes, because it is easy to read as a confidence dial and it is
 * not one.
 *
 * What it turns off is the evidence gate: `validateGrounding` still runs, its
 * failures are still recorded on the message, and the reply is sent anyway. A
 * figure the model produced from nowhere — a delivery charge for a town the
 * shop never priced, an opening time nobody set — reaches the customer in the
 * shop's name. The validator's findings become a log of what nobody could
 * confirm rather than a reason anything was held.
 *
 * What it does NOT turn off is anything structural. A catalogue price is still
 * the catalogue's, because that is not caution, it is just reading the data we
 * were given. Escalation still stops: bargaining, complaints and policy are
 * judgement calls the owner said they wanted, not accuracy checks. And the
 * 24-hour window still applies, because that one is Meta's rule, not ours.
 */
function isFullyAutonomous(mode: AiAssistMode): boolean {
  return mode === 'AUTONOMOUS';
}

/** The grounding failures that are about money, and so about a commitment. */
function isMoneyFailure(failure: GroundingFailure): boolean {
  return failure === 'unverified_amount';
}

/**
 * Whether a declared price offer is one the shop authorised.
 *
 * Three ways to fail, and all three are a refusal rather than a clamp. Clamping
 * — quietly raising the offer to the floor and sending it — would mean the
 * reply the customer reads says GHS 40 while the order says GHS 45, which is a
 * worse outcome than holding the message for the owner.
 */
export function priceOfferStatus(
  decision: AssistantDecision,
  products: EvidenceProduct[],
): 'none' | 'authorised' | 'refused' {
  const offer = decision.priceOffer;
  if (!offer) return 'none';

  const product = products.find((candidate) => candidate.id === offer.productId);
  // A price for a product that was never put in front of the model. The id is
  // invented, so there is nothing to check the number against.
  if (!product) return 'refused';

  // No ladder means the server never computed what this item may sell for — an
  // older code path, or a shop with bargaining switched off. Either way the one
  // authorised price is the one on the shelf, and this is not it.
  if (!product.ladder) return 'refused';

  const quantity =
    Number.isFinite(offer.quantity) && offer.quantity > 0 ? Math.round(offer.quantity) : 1;

  return offerIsAuthorised(product.ladder, quantity, offer.unitPrice) ? 'authorised' : 'refused';
}

function isAutoSendable(
  input: RouteInput,
  decision: AssistantDecision,
  failures: GroundingFailure[],
  escalated: boolean,
): boolean {
  const autonomous = isFullyAutonomous(input.mode);

  if (input.mode !== 'GROUNDED_AUTO' && !autonomous) return false;
  // Meta's rule, not ours, and it applies at every level of autonomy: outside
  // the service window a free-form message is refused by the API itself.
  if (!input.canDeliver) return false;
  // Still stops, even here. Bargaining, a complaint or a policy question is a
  // judgement the owner reserved — it is not an accuracy check, and turning
  // off accuracy checks was not a decision to give away the owner's authority
  // to settle a dispute or agree a discount.
  if (escalated) return false;

  // A price below the floor never goes out, in any mode.
  //
  // This sits with `canDeliver` and escalation rather than with the accuracy
  // checks below, because it is not an accuracy check. Autonomy is the owner
  // saying "answer without me". It is not the owner saying "agree to whatever
  // price you like" — those are different grants and only one of them was
  // given. A wrong fact is a sentence a customer queries. A price under the
  // floor is money the shop has agreed to lose, and it finds out at settlement.
  if (priceOfferStatus(decision, input.products) === 'refused') return false;

  // A time that was not free never goes out, in any mode, for the same reason.
  // Two people told the same slot is free is not an inaccuracy a customer can
  // query — it is two people arriving at a clinic for one appointment, and the
  // shop finds out when the second one reaches the desk.
  if (bookingOfferStatus(decision, input.evidence) === 'refused') return false;

  // The evidence gate. In autonomous mode the failures are recorded and
  // ignored; everywhere else they hold the reply for the owner.
  //
  // Except when there is haggling on the table. A shop that has set a floor has
  // put its margin inside the assistant's reach, and at that point an
  // unverified cedi figure is not a claim that might be wrong — it is a number
  // the shop can be held to. So negotiation re-arms the money half of the gate
  // that autonomy waives. Only the money half: this is the narrowest rule that
  // covers the thing autonomy was never asked to cover.
  if (failures.length > 0) {
    if (!autonomous) return false;
    if (input.evidence.negotiable && failures.some(isMoneyFailure)) return false;
  }

  if (!decision.answer.text) return false;
  if (decision.clarification.needed && !autonomous) return false;
  // A confidence floor is a proxy for "the model is guessing". A shop that has
  // accepted autonomy has accepted guesses, so the floor is theirs to have
  // waived; below it, nothing else in this function would have stopped it.
  if (decision.confidence < AUTO_SEND_CONFIDENCE && !autonomous) return false;

  // A pleasantry that claims nothing is safe to send. Everything below this
  // point verifies assertions, and there are none to verify.
  //
  // Checked BEFORE `canAnswer` on purpose, and this ordering is the whole fix
  // for the commonest complaint about this assistant. `canAnswer` is the model's
  // opinion of its own reply, and models are consistently wrong about it here:
  // asked to greet, they write "Hello! How can I help you today?" — correct, at
  // confidence 1.0 — and then set canAnswer to false, because they have been
  // told an answer citing nothing gets discarded and a greeting cites nothing.
  // Measured on live traffic, every single greeting came back canAnswer=false
  // while every product question came back true. The customer got a holding
  // line in reply to "Hello", and the owner got a queue of drafts to approve
  // that said nothing more than "hello" back.
  //
  // Rewording the prompt did not fix it; a 27B model kept setting the flag.
  // So the server decides instead, which is where the decision belonged: the
  // text asserts nothing checkable — no price, no stock, no order reference —
  // so there is nothing for it to be WRONG about, whatever the model thinks of
  // its own work. Grounding failures and escalation are still checked above,
  // and anything making a claim still falls through to the citation checks.
  // An order is a commitment, not a question. It goes through order creation
  // with the owner able to see it, never through a chat reply. Checked here,
  // ahead of the claim-free path below, so that "sure, I'll set that aside"
  // cannot slip out as a promise simply because it quotes no figure.
  // An order is a commitment. In every mode below AUTONOMOUS it goes through
  // order creation where the owner can see it; in AUTONOMOUS the assistant
  // completes it and sends the payment link itself, which is what the shop
  // asked for when they turned it on.
  if (decision.order.isOrder && !autonomous) return false;

  // Anything the reply claims to rest on has to actually exist first.
  //
  // Checked ahead of the claim-free path because a citation the server never
  // supplied is itself proof the answer is invented, whether or not the words
  // around it look harmless. The case that found this: a customer asks "what
  // time do you open?", the shop has recorded no opening hours, and the model
  // answers "We open at 8am" citing an `openingHours` fact that does not exist.
  // There is no price and no stock count in that sentence, so the claim test
  // waves it through — and the customer is told, in the shop's own name, an
  // opening time nobody ever set. A wrong opening time costs a shop a morning
  // of customers standing at a closed door.
  if (
    !autonomous &&
    !decision.answer.groundedOn.every((ref) => isKnownEvidence(ref, input.evidence))
  ) {
    return false;
  }

  // A reply that asserts nothing checkable is safe to send, whatever it is
  // about and whatever the model thinks of it.
  //
  // This is deliberately not limited to greetings any more, and that widening
  // is the fix for the complaint that outlasted every other one. Three kinds of
  // reply were being held for a human despite stating no fact at all:
  //
  //   "Hello! How can I help you today?"          - a greeting
  //   "Alright, anytime!"                         - a customer signing off
  //   "No, we don't sell corporate attire."       - a truthful no
  //
  // The last is the one that made the assistant look stupid. The shop's whole
  // catalogue is in front of the model, so it KNOWS the answer, but a negative
  // has no product row to cite, so `groundedOn` came back empty and `canAnswer`
  // false, and a customer asking a plain question got told somebody would check
  // and come back to them. Nobody needed to check anything.
  //
  // What actually makes a reply dangerous is asserting something that might be
  // untrue: a price, a stock level, an order reference, an availability claim.
  // `assertsCheckableFact` is precisely that test, and it is already the test
  // the grounding validator trusts. So it decides here too. Anything that does
  // make a claim still falls through to the citation checks below, unchanged.
  if (!assertsCheckableFact(decision.answer.text)) return true;

  // Everything past here states a fact, and it still gets sent.
  //
  // This is a deliberate reversal, made on the owner's explicit instruction
  // after watching the old rule in production. It used to read "hold unless the
  // reply proves itself" — a citation was required, and the model's own
  // `canAnswer` flag could veto. In practice that turned a shop assistant into
  // a queue of chores: a customer asked a plain question, the answer was right
  // there in the reply, and the shop sent back "let me ask about that and come
  // right back" while the owner was expected to press a button.
  //
  // It now reads "send unless the reply is provably wrong", and the proof is
  // real rather than procedural. `validateGrounding` already checks the things
  // that can actually hurt a shop, and checks them against the evidence rather
  // than against whether the model remembered to cite:
  //
  //   unverified_amount            a cedi figure that is not in the catalogue
  //   unverified_stock_claim       a stock count that is not in the catalogue
  //   availability_contradicts_stock  "we have it" when the shelf is empty
  //   unknown_order_reference      an order number nobody has
  //   foreign_phone_number / url / email
  //
  // Any of those still stops the send, above, at the `failures` gate. What is
  // gone is only the requirement to show working — the bureaucratic failure,
  // not the factual ones. A wrong price is still caught. A right answer no
  // longer needs permission.
  //
  // A reply that states something specific must rest on something real.
  //
  // This is the one piece of the old "show your working" rule worth keeping, and
  // it now applies only where it earns its place. Everything claim-free returned
  // above without ever reaching here, so this no longer holds back a greeting, a
  // thank-you, or a truthful "we don't sell that".
  //
  // What it does still catch is the invented fact: the server strips a citation
  // that pointed at evidence it never supplied, which leaves the answer resting
  // on nothing — and an answer resting on nothing, while asserting something, is
  // exactly the case where a confident sentence reaches a customer and is wrong.
  //
  // In AUTONOMOUS mode this is the gate the shop specifically bought: an answer
  // resting on nothing is exactly the ungrounded reply they asked to have sent
  // rather than held. It is recorded as unverified and goes out.
  if (!autonomous && decision.answer.groundedOn.length === 0) return false;

  // Product answers must be about one unambiguous product. "Rice is GHS 80"
  // when the shop sells two sizes of rice is wrong even though 80 is a real
  // price — which is an accuracy check, so autonomy waives it too.
  const citedProducts = new Set(
    decision.answer.groundedOn.filter((ref) => ref.kind === 'product').map((ref) => ref.id),
  );
  if (citedProducts.size > 1 && !autonomous) return false;

  return true;
}

/*
 * `isBarePleasantry` is gone, and so is the intent half of it.
 *
 * It asked two questions: is this a social intent, and does the reply claim
 * anything? Only the second turned out to matter. Restricting the exemption to
 * greetings meant a truthful "we don't sell that" — which claims nothing and is
 * the most useful sentence a shop assistant can say — was still held back.
 * `assertsCheckableFact` now stands alone, applied to every reply regardless of
 * what the customer's message was about.
 */

/**
 * Whether a bargaining escalation has already been answered by a legal offer.
 *
 * Haggling is escalated by default, and that default is right: agreeing a
 * discount is the owner's call. Setting a floor IS the owner making that call
 * in advance — "anything down to forty, decide it yourself" — so an offer that
 * lands inside it is not a judgement the owner still has to make.
 *
 * Deliberately narrow. Only a `bargaining` escalation clears, and only when the
 * model declared a price the server independently checked. A complaint, a
 * policy question or an escalation the server raised itself is untouched, and a
 * reply that merely talks about price without declaring one still goes to the
 * owner.
 */
function settledByHaggling(input: RouteInput): boolean {
  const decision = input.decision;
  if (!decision) return false;
  // The server's own escalation is not the owner's pre-authorisation to waive.
  if (input.serverEscalation) return false;
  if (decision.escalate.reason !== 'bargaining') return false;
  if (!input.evidence.negotiable) return false;

  return priceOfferStatus(decision, input.products) === 'authorised';
}

/**
 * The agreed price to bill, or null.
 *
 * Attached to every route by `routeDecision` rather than set at each of the
 * seven places a route is returned, because the one that forgets is the one
 * that silently bills a customer something other than what they were told.
 */
function authorisedOfferFrom(input: RouteInput): AuthorisedPriceOffer | null {
  const offer = input.decision?.priceOffer;
  if (!offer) return null;
  if (priceOfferStatus(input.decision!, input.products) !== 'authorised') return null;

  return {
    productId: offer.productId,
    unitPrice: offer.unitPrice,
    quantity:
      Number.isFinite(offer.quantity) && offer.quantity > 0 ? Math.round(offer.quantity) : 1,
  };
}

/**
 * The slot to take, or null.
 *
 * Same contract as `authorisedOfferFrom`: only an offer the server checked
 * against times it computed itself is carried forward.
 */
function authorisedBookingFrom(input: RouteInput): AuthorisedBooking | null {
  const offer = input.decision?.booking;
  if (!offer) return null;
  if (bookingOfferStatus(input.decision!, input.evidence) !== 'authorised') return null;

  return { serviceId: offer.serviceId, startsAt: new Date(offer.startsAt).toISOString() };
}

export function routeDecision(input: RouteInput): RouteResult {
  // One verdict each, attached to whichever route is chosen below. Computing
  // them here rather than inside each branch is what keeps the reply, the
  // invoice and the diary in agreement.
  const authorisedPriceOffer = authorisedOfferFrom(input);
  const authorisedBooking = authorisedBookingFrom(input);

  return { ...routeDecisionInner(input), authorisedPriceOffer, authorisedBooking };
}

/**
 * Everything about a route except the agreed price, which its caller attaches.
 *
 * The `Omit` is the point: it makes it a type error for a branch in here to
 * invent its own `authorisedPriceOffer`, so there is exactly one place the
 * shop's authorisation can come from.
 */
function routeDecisionInner(
  input: RouteInput,
): Omit<RouteResult, 'authorisedPriceOffer' | 'authorisedBooking'> {
  const escalated = escalationRequired(input.decision, input.serverEscalation) && !settledByHaggling(input);

  // No decision: the assistant is off, unconfigured, or failed. The existing
  // template path still answers the customer, so the pipeline degrades rather
  // than going silent.
  if (!input.decision || input.mode === 'OFF') {
    return {
      action: 'template_reply',
      holdingText: null,
      photoImageId: null,
      appendLink: null,
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
      return {
        action: 'clarify',
        holdingText: null,
        photoImageId: null,
        appendLink: null,
        text: question,
        validationFailures: [],
        escalated,
        groundedOn,
      };
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
        holdingText: null,
        photoImageId: null,
        appendLink: null,
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
      holdingText: null,
      photoImageId: null,
      appendLink: null,
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
      holdingText: null,
      photoImageId: null,
      appendLink: null,
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
    // No reply is required to show its working any more.
    //
    // A greeting has no row behind it, and neither does "we don't sell that",
    // and neither does "alright, anytime" — yet each was being held for the
    // owner to approve because `groundedOn` came back empty. That is worse
    // service than having no assistant at all.
    //
    // The figures are still checked. `unverified_amount`, `unverified_stock_claim`
    // and `availability_contradicts_stock` all compare what the reply SAYS
    // against the evidence, and none of them need a citation to do it. Dropping
    // this leaves every one of those intact and removes only the demand for
    // paperwork.
    requireCitation: false,
  });

  if (isAutoSendable(input, decision, validation.failures, escalated)) {
    return {
      action: 'auto_send',
      holdingText: null,
      // Only on the auto-send path. A draft is a sentence the owner is about to
      // edit, and attaching a photo to the holding line would send the picture
      // before the answer it belongs to.
      photoImageId: selectPhoto(decision, input.products, input.message),
      appendLink: selectLocationLink(decision, input.profile),
      text: decision.answer.text,
      // Carried through rather than emptied. Below AUTONOMOUS this is always
      // empty, because a failure would have stopped the send. In AUTONOMOUS it
      // is the record of what went out unverified — the shop chose to send it,
      // and the least the system can do is say which claims nobody could
      // confirm, so a dispute three weeks later has something to read.
      validationFailures: validation.failures,
      escalated,
      groundedOn,
    };
  }

  // The text is still worth keeping: an owner editing a nearly-right reply is
  // the whole point of drafting, and a failed check tells them where to look.
  //
  // The customer, meanwhile, gets a line about the thing they actually asked
  // about rather than the courtesy template. It is composed here, from the
  // model's reading of what was mentioned, and proved claim-free before it can
  // be sent — a holding line that guessed at availability would be worse than
  // the form letter it replaces.
  return {
    action: 'draft',
    holdingText: composeHold({ decision, message: input.message }),
    photoImageId: null,
    appendLink: null,
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
