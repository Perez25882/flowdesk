import { IntentType, type AssistantAction, type AssistantDecision, type BusinessProfile } from '@flowdesk/shared';
import type { AiAssistMode, CatalogueMode } from '@prisma/client';
import { bookingOfferStatus } from './booking-offer.js';
import { approvedNegotiatedPrice, displayLabel, explicitBookingRequest, explicitOrderRequest, explicitPaymentRequest, hasPolicyOverride, mentionsProduct, ordinaryReply, renderVerifiedFact, SAFE_CLARIFICATION, SAFE_HANDOFF } from './commitment.js';
import { isKnownEvidence } from './decision.js';
import type { EvidenceProduct, EvidenceSet } from './evidence.js';
import { validateGrounding, type GroundingFailure } from './grounding.js';

export interface RouteInput {
  mode: AiAssistMode;
  catalogueMode: CatalogueMode;
  decision: AssistantDecision | null;
  evidence: EvidenceSet;
  products: EvidenceProduct[];
  profile: BusinessProfile | null;
  serverEscalation: boolean;
  clarificationCount: number;
  canDeliver: boolean;
  message: string;
}

export interface AuthorisedPriceOffer { productId: string; unitPrice: number; quantity: number }
export interface AuthorisedBooking { serviceId: string; startsAt: string }
export type AssistantEffect = 'reply' | 'clarification' | 'order' | 'booking' | 'checkout' | 'handoff' | 'none';

export interface RouteResult {
  action: AssistantAction;
  effect: AssistantEffect;
  text: string | null;
  authorisedPriceOffer: AuthorisedPriceOffer | null;
  authorisedBooking: AuthorisedBooking | null;
  holdingText: string | null;
  photoImageId: string | null;
  appendLink: string | null;
  validationFailures: GroundingFailure[];
  escalated: boolean;
  groundedOn: string[];
}

const PHOTO_REQUEST_PATTERN = /\b(?:picture|pic|photo|image|show me|how (?:it|e) (?:look|dey look)|make i see)\b/i;
export const customerAskedForPhoto = (message: string): boolean => PHOTO_REQUEST_PATTERN.test(message);

export function priceOfferStatus(decision: AssistantDecision, products: EvidenceProduct[]): 'none' | 'authorised' | 'refused' {
  const offer = decision.priceOffer;
  if (!offer) return 'none';
  const product = products.find((item) => item.id === offer.productId);
  return product && approvedNegotiatedPrice(product, offer.quantity, offer.unitPrice) ? 'authorised' : 'refused';
}

function route(action: AssistantAction, effect: AssistantEffect, fields: Partial<RouteResult> = {}): RouteResult {
  return {
    action, effect, text: null, authorisedPriceOffer: null, authorisedBooking: null,
    holdingText: null, photoImageId: null, appendLink: null, validationFailures: [], escalated: false,
    groundedOn: [], ...fields,
  };
}

export function policyHandoff(...validationFailures: GroundingFailure[]): RouteResult {
  return route('draft', 'handoff', { escalated: true, holdingText: SAFE_HANDOFF, validationFailures });
}

function mayAutoSend(input: RouteInput): boolean {
  return input.canDeliver && (input.mode === 'AUTONOMOUS' || input.mode === 'GROUNDED_AUTO');
}

export function routeDecision(input: RouteInput): RouteResult {
  const { decision, mode, message = '', evidence, products } = input;
  if (mode === 'OFF') return route('template_reply', 'none');
  if (!decision) return policyHandoff();
  if (input.serverEscalation || hasPolicyOverride(message)) return policyHandoff('unverified_customer_request');

  const order = decision.order.isOrder || decision.intent === IntentType.ORDER;
  const offer = decision.priceOffer;
  const booking = decision.booking;
  const fact = decision.answer.fact;
  const priceStatus = priceOfferStatus(decision, products);
  const stock = products.filter((product) => decision.answer.groundedOn.some((ref) => ref.kind === 'product' && ref.id === product.id));
  const allowedAmounts = priceStatus === 'authorised' && offer
    ? new Set([...evidence.allowedAmounts, Math.round(offer.unitPrice * 100), Math.round(offer.unitPrice * offer.quantity * 100)])
    : evidence.allowedAmounts;
  const failures = decision.answer.text ? validateGrounding({
    text: decision.answer.text, evidence: { ...evidence, allowedAmounts }, groundedOn: [], citedStock: stock.map((product) => product.stockQuantity),
    requireCitation: false,
  }).failures : [];
  if (fact && decision.answer.groundedOn.filter((ref) => ref.kind === 'product' || ref.kind === 'order')
    .some((ref) => ref.id !== fact.target)) failures.push('conflicting_proposal');
  if (decision.answer.groundedOn.some((ref) => !isKnownEvidence(ref, evidence))) failures.push('ungrounded_claim');
  if (priceStatus === 'refused' ||
      (booking && (order || fact || offer || decision.clarification.needed || decision.intent === IntentType.PAYMENT)) ||
      (order && (fact || decision.intent === IntentType.PAYMENT)) ||
      (offer && !order && fact?.kind !== 'product_quote')) return policyHandoff('conflicting_proposal', ...failures);
  if (decision.escalate.needed && !(decision.escalate.reason === 'bargaining' && priceStatus === 'authorised')) {
    return policyHandoff(...failures);
  }
  if (failures.length) return policyHandoff(...failures);

  const maySend = mayAutoSend(input);
  if (booking) {
    const service = evidence.services.get(booking.serviceId);
    if (!service || bookingOfferStatus(decision, evidence) !== 'authorised' ||
        !explicitBookingRequest(message, service.name, new Date(booking.startsAt))) {
      return policyHandoff('unverified_customer_request');
    }
    if (!maySend || decision.confidence < 0.8) return policyHandoff();
    return route('auto_send', 'booking', {
      authorisedBooking: { serviceId: booking.serviceId, startsAt: new Date(booking.startsAt).toISOString() },
      groundedOn: [`service:${booking.serviceId}`],
    });
  }

  if (order || decision.clarification.needed) {
    const lines = decision.entities.products;
    if (order && lines.length && decision.order.complete && !decision.clarification.needed && maySend && decision.confidence >= 0.8 && explicitOrderRequest(message)) {
      return route('auto_send', 'order', { authorisedPriceOffer: offer,
        groundedOn: lines.flatMap((item) => item.productId ? [`product:${item.productId}`] : []) });
    }
    if (input.canDeliver && input.clarificationCount < 2 && !offer && explicitOrderRequest(message) &&
        (decision.clarification.needed || (order && (!decision.order.complete || !lines.length)))) {
      const candidates = products.filter((product) => mentionsProduct(message, product));
      const labels = candidates.slice(0, 5).map((product) => displayLabel(product.name)).filter(Boolean);
      const text = labels.length > 1 ? `Which item would you like? Options: ${labels.join(', ')}.` :
        labels.length === 1 ? `How many units of ${labels[0]} would you like?` : SAFE_CLARIFICATION;
      return route('clarify', 'clarification', { text, groundedOn: candidates.map((item) => `product:${item.id}`) });
    }
    return policyHandoff();
  }

  if (decision.intent === IntentType.PAYMENT && !fact) {
    return maySend && mode === 'AUTONOMOUS' && decision.confidence >= 0.8 && explicitPaymentRequest(message)
      ? route('auto_send', 'checkout') : policyHandoff('unverified_customer_request');
  }

  const verified = fact ? renderVerifiedFact({ proposal: fact, offer, message, evidence, products, profile: input.profile }) : null;
  if (fact && !verified) return policyHandoff('unsupported_commitment');
  const text = verified?.text ?? ordinaryReply(message, decision.answer.text);
  if (!text) return policyHandoff('unsupported_commitment');

  const send = maySend && (!verified || decision.confidence >= 0.8);
  return route(send ? 'auto_send' : 'draft', 'reply', {
    text, holdingText: send ? null : SAFE_HANDOFF,
    groundedOn: verified?.references ?? [], appendLink: verified?.link ?? null,
    authorisedPriceOffer: offer,
    photoImageId: send && fact?.kind === 'product_quote' && customerAskedForPhoto(message)
      ? products.find((product) => product.id === fact.target)?.photoId ?? null : null,
  });
}

export function requiresReview(intent: IntentType, confidence: number, action: AssistantAction, escalated: boolean): boolean {
  if (escalated || intent === IntentType.UNCLASSIFIED || confidence < 0.6) return true;
  if (action === 'auto_send' || action === 'clarify') return false;
  return action === 'draft' || intent === IntentType.COMPLAINT || intent === IntentType.INQUIRY || intent === IntentType.PAYMENT;
}
