import type { AssistantDecision, AssistantFactProposal, BusinessProfile } from '@flowdesk/shared';
import type { EvidenceProduct, EvidenceSet } from './evidence.js';
import { offerIsAuthorised, unitPriceForQuantity } from '../pricing/ladder.js';

function approvedUnitPrice(product: EvidenceProduct, quantity: number): number {
  return product.ladder ? unitPriceForQuantity(product.ladder, quantity) : product.price;
}

export function approvedNegotiatedPrice(product: EvidenceProduct, quantity: number, price: number): boolean {
  const standard = approvedUnitPrice(product, quantity);
  return Number.isSafeInteger(quantity) && quantity > 0 && Number.isFinite(price) && price > 0 &&
    Math.abs(price * 100 - Math.round(price * 100)) < 1e-7 && price <= standard &&
    (product.ladder ? offerIsAuthorised(product.ladder, quantity, price) : price === standard);
}

export const SAFE_HANDOFF = 'Thanks for your message. The shop team can help you with this.';
export const SAFE_CLARIFICATION = 'Which item and quantity would you like?';

const INSTRUCTION = /\b(?:ignore (?:all |any |the )?(?:previous|prior|system) (?:instructions|rules)|system prompt|developer message|(?:i am|i'm) (?:the |your )?(?:owner|admin)|(?:call|invoke|execute) (?:a |the )?tool|override (?:the )?(?:policy|rules))\b/i;
export const hasPolicyOverride = (text: string): boolean => INSTRUCTION.test(text.normalize('NFKC').replace(/\p{Cf}/gu, ''));

const money = (amount: number): string => `GHS ${amount.toFixed(2)}`;
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const mentioned = (input: string, term: string): boolean => {
  const needle = normalize(term);
  return needle.length > 0 && ` ${normalize(input)} `.includes(` ${needle} `);
};

export function mentionsProduct(input: string, product: EvidenceProduct): boolean {
  return [product.name, ...(product.aliases ?? [])].some((term) => mentioned(input, term));
}

export function hasUnambiguousProduct(input: string, product: EvidenceProduct, products: EvidenceProduct[]): boolean {
  if (!mentionsProduct(input, product)) return false;
  const exactNames = products.filter((item) => mentioned(input, item.name));
  const matches = exactNames.length ? exactNames : products.filter((item) => mentionsProduct(input, item));
  return matches.length === 1 && matches[0]?.id === product.id;
}

function explicitProductRequest(input: string): boolean {
  return /\b(?:how much|price|cost|quote|cedis|ghs|last price|discount|picture|photo|pic|show me|how e dey look|make i see|stock|available|have)\b/i.test(input);
}

export function displayLabel(label: string): string | null {
  return /^[\p{L}\p{M}\p{N} .&()+/,'-]{1,80}$/u.test(label) && !hasPolicyOverride(label) ? `“${label}”` : null;
}

export function ordinaryReply(message: string, proposed: string | null): string | null {
  const input = normalize(message);
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|akwaaba|chale|yo)$/.test(input)) {
    return 'Hello! How can we help?';
  }
  if (/^(thanks|thank you|thanks so much|thank you very much|medaase|alright thanks|ok thanks)$/.test(input)) {
    return 'You’re welcome!';
  }
  if (/^(ok|okay|alright|noted|bye|goodbye|great|sure)$/.test(input)) return 'Thank you!';
  if (/^(what do you (sell|have)|show me (your )?(catalogue|catalog|products)|what (can i buy|is on sale))$/.test(input)) {
    return 'What kind of item are you looking for?';
  }
  if (proposed && /^(how can (we|i) help( you)?( today)?|could you (tell (us|me) more|share more details))$/.test(normalize(proposed))) {
    return 'Could you share a little more about what you need?';
  }
  return null;
}

export function explicitPaymentRequest(body: string): boolean {
  return /^(?:please )?(?:how (?:do|can) i pay|(?:please )?send (?:me )?(?:a |the |my )?payment link|i (?:want|need) to pay)(?: for (?:my |the )?order)?[.!? ]*$/i.test(body.trim());
}

export function explicitOrderRequest(body: string): boolean {
  if (/\b(?:not|never|cancel|if|unless|instead|maybe|or|no|only|how much|how many|price|availability|available)\b/i.test(body)) return false;
  return /^(?:(?:hello|hi|hey|good morning)[,.!]\s*)?(?:please\s+)?(?:(?:i(?:'d| would) like|i (?:want|need)|we (?:want|need))(?: to (?:buy|order))?|(?:can|could) i (?:get|buy|order|have)|(?:buy|order|get|send me|give me))\s+[^?]+[.!]?$/i.test(body.trim());
}

export function explicitBookingRequest(body: string, serviceName: string, startsAt: Date): boolean {
  if (/\b(?:not|never|cancel|if|unless|instead|maybe|or)\b/i.test(body)) return false;
  const time = slotLabel(startsAt);
  const withoutDate = body.replace(startsAt.toISOString(), '').replace(startsAt.toISOString().replace('.000', ''), '');
  return /^(?:please\s+)?(?:(?:i want to|i would like to|can i|could i)\s+)?(?:book|reserve|schedule)\s+/i.test(body.trim()) && mentioned(body, serviceName) &&
    (withoutDate !== body || mentioned(body, time));
}

export function slotLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(date);
}

export interface VerifiedReply {
  text: string;
  references: string[];
  link?: string;
}

interface FactInput {
  proposal: AssistantFactProposal;
  offer?: AssistantDecision['priceOffer'];
  message: string;
  evidence: EvidenceSet;
  products: EvidenceProduct[];
  profile: BusinessProfile | null;
}

export function renderVerifiedFact(input: FactInput): VerifiedReply | null {
  const { proposal: { kind, target, quantity }, offer, message, evidence, products, profile } = input;
  if (hasPolicyOverride(message) || (quantity !== null && kind !== 'product_quote' && kind !== 'product_stock')) return null;

  if (kind === 'product_quote' || kind === 'product_stock') {
    const product = products.find((item) => item.id === target);
    if (!product || !hasUnambiguousProduct(message, product, products) || !explicitProductRequest(message)) return null;
    const name = displayLabel(product.name);
    if (!name) return null;
    const count = quantity ?? 1;
    if (count > 1 && !evidence.mentionedQuantities.has(count)) return null;
    const references = [`product:${product.id}`];
    if (kind === 'product_stock') {
      const available = product.stockQuantity >= count;
      return { text: available ? `${name} is currently in stock.` : `We don’t currently have that quantity of ${name} in stock.`, references };
    }
    if (product.stockQuantity < count) return null;
    let price = approvedUnitPrice(product, count);
    if (offer) {
      if (offer.productId !== product.id || offer.quantity !== count || !approvedNegotiatedPrice(product, count, offer.unitPrice)) return null;
      price = offer.unitPrice;
    }
    if (!Number.isFinite(price) || price <= 0) return null;
    return { text: `${name} costs ${money(price)} per unit.${count > 1 ? ` ${count} units cost ${money(price * count)}.` : ''}`, references };
  }

  if (kind === 'order_status' || kind === 'payment_balance') {
    const order = target ? evidence.orders.get(target) : undefined;
    if (!order || !mentioned(message, order.referenceNumber) || !/^FD-[A-Z0-9]{3,}$/i.test(order.referenceNumber)) return null;
    const references = [`order:${order.id}`];
    if (kind === 'payment_balance') {
      if (!/\b(?:paid|pay|payment|balance|owe|outstanding)\b/i.test(message) || order.status === 'PENDING') return null;
      return { text: `Order ${order.referenceNumber} has ${money(Math.max(0, order.totalAmount - order.amountPaid))} outstanding.`, references };
    }
    const status: Record<string, string> = {
      PENDING: 'awaiting confirmation', CONFIRMED: 'confirmed', PROCESSING: 'being prepared', DISPATCHED: 'dispatched', FULFILLED: 'fulfilled',
    };
    const label = status[order.status];
    return label ? { text: `Order ${order.referenceNumber} is ${label}.`, references } : null;
  }

  if (kind === 'delivery_fee') {
    if (!target || !mentioned(message, target) || !/\b(?:deliver|delivery|shipping|ship|fee)\b/i.test(message)) return null;
    const zones = profile?.deliveryZones?.filter((item) => normalize(item.area || item.town) === normalize(target)) ?? [];
    if (zones.length > 1) return null;
    const zone = zones[0];
    const area = zone && (zone.area || zone.town);
    const covered = profile?.deliveryAreas?.find((item) => normalize(item) === normalize(target));
    const fee = zone?.fee ?? (covered ? profile?.deliveryFee : undefined);
    const label = displayLabel(area ?? covered ?? '');
    if (!label || typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) return null;
    return { text: `The listed delivery fee for ${label} is ${money(fee)}.`, references: ['fact:deliveryFee'] };
  }

  if (kind === 'business_location') {
    const link = profile?.locationUrl;
    if (target !== null || !/\b(?:location|where|address|directions)\b/i.test(message) || !link) return null;
    if (/^[A-Z]{2}-\d{3,4}-\d{3,4}$/i.test(link)) return { text: `The shop’s GhanaPost code is ${link}.`, references: ['fact:locationUrl'] };
    const url = URL.canParse(link) ? new URL(link) : null;
    return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/\s/.test(link)
      ? { text: 'Here is the shop’s location.', references: ['fact:locationUrl'], link } : null;
  }

  if (kind === 'booking_slots') {
    const service = target ? evidence.services.get(target) : undefined;
    if (!service || !mentioned(message, service.name) || !/\b(?:book|slots?|availability|available|times?|appointment)\b/i.test(message)) return null;
    const label = displayLabel(service.name);
    const slots = service.slots.filter((slot) => slot.startsAt.getTime() > Date.now()).slice(0, 3);
    if (!label || !slots.length) return null;
    return {
      text: `Currently open for ${label}: ${slots.map((slot) => slotLabel(slot.startsAt)).join('; ')}. Which time would you like?`,
      references: [`service:${service.id}`],
    };
  }

  return null;
}
