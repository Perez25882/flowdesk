import type { AiAssistMode, BusinessType, CatalogueMode, Prisma } from '@prisma/client';
import type { BusinessProfile } from '@flowdesk/shared';
import { prisma } from '../../config/database.js';
import { findCandidateProducts } from '../../utils/item-extractor.js';
import type { CatalogProductWithStock } from '../../modules/products/products.repository.js';
import { findCatalogProductsWithStock } from '../../modules/products/products.repository.js';
import { buildLadder } from '../pricing/ladder.js';
import { findSlots, listServices } from '../../modules/bookings/bookings.service.js';
import { describeImageForReply } from './describe-image.js';
import { resolveRepliedTo } from './status-context.js';
import {
  buildEvidenceSet,
  type EvidenceOrder,
  type EvidenceProduct,
  type EvidenceService,
  type EvidenceSet,
} from './evidence.js';
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

/**
 * A Status post can be long. Only the opening matters for working out what the
 * customer is pointing at, and the rest is prompt weight.
 */

/** The message a customer was replying to, reduced to what the model needs. */
export interface RepliedToMessage {
  /** What it said, or what the picture shows. Null when we hold neither. */
  body: string | null;
  fromShop: boolean;
  /** True when the thing replied to was a picture rather than text. */
  isImage: boolean;
  /** True when the referenced message is one we never received at all. */
  unresolved: boolean;
}

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
  bookingsEnabled?: boolean;
  /**
   * The shop's master switch for negotiation.
   *
   * Optional so the replay script and the hand-built test fixtures keep
   * working. Absent reads as off, which is the behaviour every shop has until
   * its owner turns it on.
   */
  bargainingEnabled?: boolean;
}

export interface AssembleContextInput {
  business: AssistantBusiness;
  catalog: CatalogProductWithStock[];
  /**
   * Bookable services with their free times, already checked against the diary.
   *
   * Loaded before the model runs, never during, and never by the model asking.
   * A time that is not in here was not free at the moment the prompt was built,
   * and the router refuses any booking for one that is not.
   */
  services?: EvidenceService[];
  openOrders: EvidenceOrder[];
  history: ConversationTurn[];
  /** A question we already asked and are waiting on, so a bare reply is read as its answer. */
  awaitingClarification: string | null;
  /** Replies the owner wrote themselves, shown to the model as tone only. */
  voiceExamples: string[];
  /**
   * The message this one replies to, when Meta told us there was one.
   *
   * Optional so the two test files that build this input by hand, and the replay
   * script, keep working without it. Absent means the same as it always did:
   * treat the message as standing on its own.
   */
  replyingTo?: RepliedToMessage | null;
  message: string;
}

export interface AssistantContext {
  systemPrompt: string;
  userPrompt: string;
  evidence: EvidenceSet;
  /** The rows that were rendered — the clarification composer needs the same ones. */
  products: EvidenceProduct[];
  services: EvidenceService[];
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

/**
 * The catalogue row as the model and the validator both see it.
 *
 * The ladder is computed HERE, once, and the same object is used to render the
 * prompt, to build the allowed amounts and to check the offer the model comes
 * back with. Computing it twice would let the prompt and the enforcement
 * disagree — the model told one floor and judged against another — which is
 * the specific bug that would make this feature look arbitrary to an owner.
 */
function toEvidenceProduct(
  product: CatalogProductWithStock,
  bargainingEnabled: boolean,
): EvidenceProduct {
  return {
    id: product.id,
    name: product.name,
    unit: product.unit,
    price: product.price,
    stockQuantity: product.stockQuantity,
    photoId: product.photoId,
    ladder: buildLadder({
      price: product.price,
      floorPrice: product.floorPrice,
      discountPercent: product.discountPercent,
      discountLabel: product.discountLabel,
      discountEndsAt: product.discountEndsAt,
      tiers: product.tiers,
      bargainingEnabled,
    }),
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
  bargainingEnabled = false,
): EvidenceProduct[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const candidates = findCandidateProducts(message, catalog, MAX_CANDIDATE_PRODUCTS);

  const matched = candidates
    .map((candidate) => byId.get(candidate.product.id))
    .filter((p): p is CatalogProductWithStock => p !== undefined)
    .map((p) => toEvidenceProduct(p, bargainingEnabled));

  if (matched.length > 0) return matched;

  if (catalog.length > 0 && catalog.length <= SMALL_CATALOGUE_LIMIT) {
    return catalog.map((p) => toEvidenceProduct(p, bargainingEnabled));
  }

  return [];
}

export function assembleContext(input: AssembleContextInput): AssistantContext {
  const { business } = input;
  const products = selectCandidateProducts(
    input.message,
    input.catalog,
    business.bargainingEnabled ?? false,
  );

  // Whether the model is looking at the whole shop or only the rows that matched.
  //
  // `selectCandidateProducts` already returns the entire catalogue for a small
  // shop when nothing matched. The knowledge was there; we simply never said so,
  // and the model dutifully offered to "check" for a product it could see the
  // shop does not sell. Comparing counts is what makes the difference sayable.
  const catalogueComplete = input.catalog.length > 0 && products.length === input.catalog.length;

  const services = input.services ?? [];

  const evidence = buildEvidenceSet({
    products,
    services,
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
    services,
    catalogueComplete,
    replyingTo: input.replyingTo ?? null,
    catalogueMode: business.catalogueMode,
    unsupervised: business.aiAssistMode === 'AUTONOMOUS',
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
    services,
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
  bargainingEnabled: true,
  bookingsEnabled: true,
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
 *
 * That breadth is why `carriesPersonalDetail` below is not optional. These are
 * the owner's words to *other* customers, so an example has to be safe to show
 * to a stranger before it can be used to teach tone.
 */

/**
 * True when an example carries something belonging to one particular customer.
 *
 * These lines go into the prompt whole, under an instruction to imitate them. A
 * model told to copy the register of "Kwame, your 12 bags are set aside, balance
 * GHS 400, I'll drop them at East Legon Friday" copies the name, the balance and
 * the neighbourhood along with the register — into a reply addressed to someone
 * else entirely.
 *
 * So this selects rather than redacts. An example is used only when it can be
 * shown to carry nothing personal; anything unproven is dropped. Rejecting a
 * good line costs nothing — we over-fetch, and the worst case is a shorter list
 * and a flatter greeting — while admitting a bad one puts one customer's
 * business in front of another. A redaction pass would have to recognise every
 * Ghanaian name and neighbourhood to be safe. This has to recognise none.
 */
export function carriesPersonalDetail(body: string): boolean {
  // Digits cover order references, balances, quantities, phone numbers, dates.
  if (/\d/.test(body)) return true;

  // Money and handles, written out rather than in figures.
  if (/[@₵]|\bGH[S₵]\b|\bcedis?\b/i.test(body)) return true;

  // A capitalised word that does not open a sentence is usually a person or a
  // place. Sentence-initial words carry no such signal, so they are skipped.
  for (const sentence of body.split(/(?<=[.!?])\s+/)) {
    const afterFirstWord = sentence.trim().split(/\s+/).slice(1);
    if (afterFirstWord.some((word) => /^[A-Z][a-z’']/.test(word))) return true;
  }

  return false;
}

export async function loadOwnerVoice(businessId: string): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: {
      businessId,
      direction: 'OUTBOUND',
      sentFromApp: true,
      body: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    // Over-fetch: the filters below discard "ok" and "noted", and then most of
    // what survives, since any line naming a customer or an amount is dropped.
    // Fetching exactly six would leave the prompt with none.
    take: MAX_VOICE_EXAMPLES * 12,
    select: { body: true },
  });

  const seen = new Set<string>();
  const examples: string[] = [];

  for (const row of rows) {
    const body = row.body?.trim();
    if (!body || body.length < MIN_VOICE_EXAMPLE_LENGTH) continue;

    // This example was written to a different customer. Tone may cross that
    // boundary; their name, balance and address may not.
    if (carriesPersonalDetail(body)) continue;

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
      // DISPATCHED counts as open: the customer most likely to ask "where is my
      // order" is the one whose order is already on the way, and leaving it out
      // meant the assistant answered as though they had no order at all.
      status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED'] },
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
/**
 * The message this one is a reply to, when there is one.
 *
 * Two hops, because Meta gives us its id rather than its text: read
 * `replyToWaId` off the incoming message, then find the message carrying that
 * `waMessageId`. Scoped to the business, so one shop can never resolve a reply
 * against another shop's message.
 *
 * The case that matters most is a Status reply. Plenty of Ghanaian shops sell by
 * posting goods to WhatsApp Status and answering whoever replies, and those
 * replies arrive as "how much?" or "is it still there?" — pronouns with nothing
 * to attach to. The thing being asked about is one lookup away, and until now
 * the assistant was left to guess or ask.
 */
async function loadRepliedToMessage(
  businessId: string,
  messageId: string,
): Promise<RepliedToMessage | null> {
  const current = await prisma.message.findFirst({
    where: { id: messageId, businessId },
    select: { replyToWaId: true },
  });

  if (!current?.replyToWaId) return null;

  // Everything about WHAT was replied to — caption, stored description, or the
  // honest admission that we hold nothing — lives in `status-context.ts`, so
  // the four cases can be argued with in a test rather than here.
  const context = await resolveRepliedTo(businessId, current.replyToWaId, describeImageForReply);
  if (!context) return null;

  return context;
}

/**
 * Every service this shop offers, with the times that are actually free.
 *
 * Capped hard. Six services at eight slots each is forty-eight times in the
 * prompt, which is already more than a customer wants read out at them, and
 * the cost of the arithmetic is paid on every single inbound message.
 */
async function loadBookableServices(businessId: string): Promise<EvidenceService[]> {
  const services = await listServices(businessId, true);
  if (services.length === 0) return [];

  const from = new Date();

  const withSlots = await Promise.all(
    services.slice(0, 6).map(async (service) => {
      const { slots } = await findSlots(businessId, {
        serviceId: service.id,
        from,
        days: 14,
        limit: 8,
      });

      return {
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        price: service.price,
        slots: slots.map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt })),
      };
    }),
  );

  return withSlots;
}

export async function loadAssistantContext(
  input: LoadContextInput,
): Promise<LoadedContext | null> {
  const [business, catalog, history, openOrders, voiceExamples, replyingTo] = await Promise.all([
    loadAssistantBusiness(input.businessId),
    findCatalogProductsWithStock(input.businessId),
    loadConversationHistory(input.businessId, input.customerId, input.messageId),
    loadOpenOrders(input.businessId, input.customerId),
    loadOwnerVoice(input.businessId),
    loadRepliedToMessage(input.businessId, input.messageId),
  ]);

  if (!business) return null;

  // Loaded after the business, not alongside it, because most shops have no
  // diary and running the slot arithmetic for them would be work done to
  // produce an empty array on every inbound message.
  const services = business.bookingsEnabled
    ? await loadBookableServices(input.businessId)
    : [];

  const context = assembleContext({
    business,
    catalog,
    services,
    openOrders,
    history,
    awaitingClarification: input.awaitingClarification ?? null,
    voiceExamples,
    replyingTo,
    message: input.message,
  });

  return { ...context, business };
}
