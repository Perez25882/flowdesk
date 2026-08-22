import type { AiAssistMode, BusinessType, CatalogueMode, Prisma } from '@prisma/client';
import type { BusinessProfile } from '@flowdesk/shared';
import { prisma } from '../../config/database.js';
import { findCandidateProducts } from '../../utils/item-extractor.js';
import type { CatalogProductWithStock } from '../../modules/products/products.repository.js';
import { findCatalogProductsWithStock } from '../../modules/products/products.repository.js';
import { buildEvidenceSet, type EvidenceOrder, type EvidenceProduct, type EvidenceSet } from './evidence.js';
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildUserPrompt,
  type ConversationTurn,
} from './prompt.js';

/**
 * Everything the model is allowed to know about this message.
 *
 * Split in two on purpose. `assembleContext` is pure — given rows, it decides
 * what goes in the prompt and what the answer may therefore contain, and it is
 * the half worth testing. `loadAssistantContext` is the half that talks to the
 * database.
 *
 * The retrieval decisions here set the ceiling on what the assistant can say:
 * the evidence set is built from exactly the rows rendered into the prompt, so
 * anything not retrieved here is, as far as the validator is concerned, not true.
 */

/** Catalogue rows to retrieve for one message. Beyond this the prompt stops helping. */
const MAX_CANDIDATE_PRODUCTS = 8;

/**
 * When nothing matched and the shop is small, send the whole catalogue.
 *
 * "What do you sell?" and "do you have anything cheaper?" are ordinary questions
 * that match no product term, and a shop with a dozen items can answer them
 * properly. Above this the prompt cost stops being worth it and the assistant
 * says it does not know instead.
 */
const SMALL_CATALOGUE_LIMIT = 25;

/** Turns of history. Enough to resolve "the same again", short enough to stay cheap. */
const MAX_HISTORY_TURNS = 6;

/**
 * Owner-written replies used as tone exemplars.
 *
 * Six is enough to establish a register and short enough not to crowd the
 * catalogue out of the prompt.
 */
const MAX_VOICE_EXAMPLES = 6;

/**
 * Below this a reply carries no style — "ok", "yes", "noted" tell the model
 * nothing about how the shop talks, and they would crowd out ones that do.
 */
const MIN_VOICE_EXAMPLE_LENGTH = 25;

/** Long enough to show phrasing, short enough that six of them stay cheap. */
const MAX_VOICE_EXAMPLE_LENGTH = 220;

/** Open orders are the ones a customer might ask about; older ones are noise. */
const MAX_OPEN_ORDERS = 5;

/**
 * Number words a customer plausibly uses for a quantity.
 *
 * Stops at twelve on purpose: past that people reach for digits, and every
 * extra word widens the set of amounts the validator will accept.
 */
const QUANTITY_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  // Common in Ghanaian English and Twi-English mixes.
  couple: 2,
  dozen: 12,
};

const WORD_QUANTITY_PATTERN = new RegExp(
  `\\b(${Object.keys(QUANTITY_WORDS).join('|')})\\b`,
  'gi',
);

/** Quantities above this are not real orders, and deriving totals for them is waste. */
const MAX_PLAUSIBLE_QUANTITY = 100;

export interface AssistantBusiness {
  id: string;
  name: string;
  phone: string | null;
  businessType: BusinessType | null;
  businessTypeOther: string | null;
  businessProfile: BusinessProfile | null;
  businessPolicyNotes: string | null;
  aiAssistMode: AiAssistMode;
  catalogueMode: CatalogueMode;
  waDisplayNumber: string | null;
}

export interface AssembleContextInput {
  business: AssistantBusiness;
  catalog: CatalogProductWithStock[];
  openOrders: EvidenceOrder[];
  history: ConversationTurn[];
  /** A question we already asked and are waiting on, so a bare reply is read as its answer. */
  awaitingClarification: string | null;
  /** Replies the owner wrote themselves, shown to the model as tone only. */
  voiceExamples: string[];
  message: string;
}

export interface AssistantContext {
  systemPrompt: string;
  userPrompt: string;
  evidence: EvidenceSet;
  /** The rows that were rendered — the clarification composer needs the same ones. */
  products: EvidenceProduct[];
  profile: BusinessProfile | null;
}

/**
 * Numbers the customer actually wrote.
 *
 * Feeds the evidence set so "how much for 3?" can be answered with a subtotal.
 * Deliberately only what is in the message: allowing every quantity from 1 to 100
 * would make almost any multiple of any price verifiable, which is most of the
 * validator's value gone.
 */
export function extractMentionedQuantities(text: string): number[] {
  const found = new Set<number>();

  const add = (value: number): void => {
    if (Number.isInteger(value) && value > 0 && value <= MAX_PLAUSIBLE_QUANTITY) {
      found.add(value);
    }
  };

  for (const match of text.matchAll(/\b(\d{1,3})\b/g)) {
    add(Number(match[1]));
  }

  // "two crates" is the same order as "2 crates", and people write it both
  // ways. Reading only digits meant the evidence set held no quantity for the
  // worded form, so the correct subtotal the model then derived — GHS 264 for
  // two crates at GHS 132 — failed validation as an unverified amount and a
  // right answer was held back for approval.
  for (const match of text.matchAll(WORD_QUANTITY_PATTERN)) {
    const word = match[1]?.toLowerCase();
    if (word) add(QUANTITY_WORDS[word] ?? 0);
  }

  return [...found];
}

function toEvidenceProduct(product: CatalogProductWithStock): EvidenceProduct {
  return {
    id: product.id,
    name: product.name,
    unit: product.unit,
    price: product.price,
    stockQuantity: product.stockQuantity,
  };
}

/**
 * Picks the catalogue rows this message is about.
 *
 * Recall matters more than precision here: an extra row costs a few tokens,
 * while a missing one means the assistant cannot answer a question it should
 * have been able to — and, worse, may be tempted to answer it anyway.
 */
export function selectCandidateProducts(
  message: string,
  catalog: CatalogProductWithStock[],
): EvidenceProduct[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const candidates = findCandidateProducts(message, catalog, MAX_CANDIDATE_PRODUCTS);

  const matched = candidates
    .map((candidate) => byId.get(candidate.product.id))
    .filter((p): p is CatalogProductWithStock => p !== undefined)
    .map(toEvidenceProduct);

  if (matched.length > 0) return matched;

  if (catalog.length > 0 && catalog.length <= SMALL_CATALOGUE_LIMIT) {
    return catalog.map(toEvidenceProduct);
  }

  return [];
}

export function assembleContext(input: AssembleContextInput): AssistantContext {
  const { business } = input;
  const products = selectCandidateProducts(input.message, input.catalog);

  const evidence = buildEvidenceSet({
    products,
    profile: business.businessProfile,
    openOrders: input.openOrders,
    mentionedQuantities: extractMentionedQuantities(input.message),
    businessPhones: [business.phone, business.waDisplayNumber],
  });

  const userPrompt = buildUserPrompt({
    businessName: business.name,
    businessType: business.businessType,
    businessTypeOther: business.businessTypeOther,
    profile: business.businessProfile,
    policyNotes: business.businessPolicyNotes,
    products,
    catalogueMode: business.catalogueMode,
    openOrders: input.openOrders,
    history: input.history,
    awaitingClarification: input.awaitingClarification,
    voiceExamples: input.voiceExamples,
    message: input.message,
  });

  return {
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    userPrompt,
    evidence,
    products,
    profile: business.businessProfile,
  };
}

/**
 * `satisfies`, not `as const`.
 *
 * A bare const passed to `select` gets no excess-property check, so a field that
 * does not exist on the model type-checks cleanly and then throws at runtime on
 * the first real query — which, for this path, means every inbound message.
 * `satisfies Prisma.BusinessSelect` makes a typo a build error again.
 */
const BUSINESS_CONTEXT_SELECT = {
  id: true,
  name: true,
  phone: true,
  businessType: true,
  businessTypeOther: true,
  businessProfile: true,
  businessPolicyNotes: true,
  aiAssistMode: true,
  catalogueMode: true,
  waDisplayNumber: true,
} satisfies Prisma.BusinessSelect;

/**
 * `businessProfile` is a JSON column, so Prisma hands it back as `JsonValue`.
 * Anything that is not an object is treated as absent rather than coerced — a
 * malformed profile must not become a fact the assistant states.
 */
function readProfile(value: unknown): BusinessProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as BusinessProfile;
}

export async function loadAssistantBusiness(
  businessId: string,
): Promise<AssistantBusiness | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: BUSINESS_CONTEXT_SELECT,
  });

  if (!business) return null;

  return {
    id: business.id,
    name: business.name,
    phone: business.phone,
    businessType: business.businessType,
    businessTypeOther: business.businessTypeOther,
    businessProfile: readProfile(business.businessProfile),
    businessPolicyNotes: business.businessPolicyNotes,
    aiAssistMode: business.aiAssistMode,
    catalogueMode: business.catalogueMode,
    waDisplayNumber: business.waDisplayNumber,
  };
}

/**
 * The last few turns, oldest first.
 *
 * Queried newest-first so the index does the work, then reversed — reading a
 * conversation backwards would leave the model resolving "it" against a message
 * that has not happened yet.
 */
export async function loadConversationHistory(
  businessId: string,
  customerId: string,
  excludeMessageId: string,
): Promise<ConversationTurn[]> {
  const rows = await prisma.message.findMany({
    where: {
      businessId,
      customerId,
      id: { not: excludeMessageId },
      body: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_TURNS,
    select: { direction: true, body: true },
  });

  return rows
    .reverse()
    .filter((row): row is { direction: typeof row.direction; body: string } => row.body !== null)
    .map((row) => ({
      from: row.direction === 'INBOUND' ? ('customer' as const) : ('shop' as const),
      text: row.body,
    }));
}

/**
 * The shop's own voice: replies the owner typed on their own phone.
 *
 * `sentFromApp` marks messages that arrived as echoes from the WhatsApp
 * Business app — the owner writing to their own customer, unmediated. Those are
 * the only messages in the table guaranteed not to have been written by this
 * assistant, so training the tone on them cannot feed the model its own output
 * back and flatten every shop towards the same voice.
 *
 * Not scoped to one customer on purpose: how a shop talks is a property of the
 * shop, and a new customer is exactly the conversation with no history to learn
 * from.
 */
export async function loadOwnerVoice(businessId: string): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: {
      businessId,
      direction: 'OUTBOUND',
      sentFromApp: true,
      body: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    // Over-fetch: the length filter below discards "ok" and "noted", and
    // fetching exactly six would leave the prompt with one usable example.
    take: MAX_VOICE_EXAMPLES * 4,
    select: { body: true },
  });

  const seen = new Set<string>();
  const examples: string[] = [];

  for (const row of rows) {
    const body = row.body?.trim();
    if (!body || body.length < MIN_VOICE_EXAMPLE_LENGTH) continue;

    // A shop that answers "we open at 8" twenty times a day would otherwise
    // fill every slot with the same sentence.
    const key = body.slice(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    examples.push(body.slice(0, MAX_VOICE_EXAMPLE_LENGTH));
    if (examples.length >= MAX_VOICE_EXAMPLES) break;
  }

  return examples;
}

/** Orders this customer could plausibly be asking about. */
export async function loadOpenOrders(
  businessId: string,
  customerId: string,
): Promise<EvidenceOrder[]> {
  const orders = await prisma.order.findMany({
    where: {
      businessId,
      customerId,
      deletedAt: null,
      status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING'] },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_OPEN_ORDERS,
    select: {
      id: true,
      referenceNumber: true,
      status: true,
      totalAmount: true,
      amountPaid: true,
    },
  });

  return orders.map((order) => ({
    id: order.id,
    referenceNumber: order.referenceNumber,
    status: order.status,
    // Decimal columns: converted here so no prompt ever contains `{"s":1,...}`.
    totalAmount: Number(order.totalAmount),
    amountPaid: Number(order.amountPaid),
  }));
}

export interface LoadContextInput {
  businessId: string;
  customerId: string;
  messageId: string;
  message: string;
  awaitingClarification?: string | null;
}

export interface LoadedContext extends AssistantContext {
  business: AssistantBusiness;
}

/**
 * Reads everything in parallel — these four queries have no dependency on each
 * other, and the assistant's latency budget is already dominated by the model.
 */
export async function loadAssistantContext(
  input: LoadContextInput,
): Promise<LoadedContext | null> {
  const [business, catalog, history, openOrders, voiceExamples] = await Promise.all([
    loadAssistantBusiness(input.businessId),
    findCatalogProductsWithStock(input.businessId),
    loadConversationHistory(input.businessId, input.customerId, input.messageId),
    loadOpenOrders(input.businessId, input.customerId),
    loadOwnerVoice(input.businessId),
  ]);

  if (!business) return null;

  const context = assembleContext({
    business,
    catalog,
    openOrders,
    history,
    awaitingClarification: input.awaitingClarification ?? null,
    voiceExamples,
    message: input.message,
  });

  return { ...context, business };
}
