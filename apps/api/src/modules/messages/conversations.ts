import { prisma } from '../../config/database.js';
import { NotFoundError } from '../../utils/errors.js';

/**
 * The inbox, one row per customer.
 *
 * The dashboard used to render every message as its own card, inbound and
 * outbound mixed, newest first. A shop's own replies showed up looking like
 * customer messages, and a busy afternoon would have been a single unbroken
 * wall. This groups by the person, which is how an owner thinks about it —
 * "Kwame is waiting", not "message 4,812 is waiting".
 */

export interface ConversationPreview {
  body: string | null;
  fromShop: boolean;
  at: Date;
}

export interface Conversation {
  customerId: string;
  name: string | null;
  waNumber: string;
  preview: ConversationPreview | null;
  /** Flagged customer messages nobody from the shop has answered since. */
  waiting: number;
  needsYou: boolean;
  lastActivityAt: Date;
}

interface LatestMessage {
  body: string | null;
  direction: string;
  createdAt: Date;
  sentFromApp: boolean;
  sentByStaffId: string | null;
}

export interface SummariseInput {
  customer: { id: string; name: string | null; waNumber: string; lastInteractionAt: Date | null };
  latest: LatestMessage | null;
  /** When the shop last said anything to this customer, by any route. */
  lastOutboundAt: Date | null;
  /** When each customer message flagged for review arrived. */
  flaggedInboundAt: Date[];
}

/**
 * One inbox row, and whether it needs the owner.
 *
 * "Needs you" means a flagged customer message that nobody from the shop has
 * answered SINCE. It is derived here rather than stored, because the stored
 * flag was wrong in the way that matters most: the only thing that ever
 * cleared it was re-labelling a message's intent, so answering the customer
 * left it set and the badge could only grow. Deriving it from "did the shop
 * speak after this?" is right however the reply went — dashboard, the owner's
 * own phone, or the assistant — with nothing having to remember to clear it.
 */
export function summariseConversation(input: SummariseInput): Conversation {
  const { customer, latest, lastOutboundAt, flaggedInboundAt } = input;

  const waiting = flaggedInboundAt.filter(
    (at) => lastOutboundAt === null || at.getTime() > lastOutboundAt.getTime(),
  ).length;

  return {
    customerId: customer.id,
    name: customer.name,
    waNumber: customer.waNumber,
    preview: latest
      ? { body: latest.body, fromShop: latest.direction === 'OUTBOUND', at: latest.createdAt }
      : null,
    waiting,
    needsYou: waiting > 0,
    // Older customer rows predate the column, so fall back to the newest
    // message rather than showing no time at all.
    lastActivityAt: customer.lastInteractionAt ?? latest?.createdAt ?? new Date(0),
  };
}

export type ConversationFilter = 'all' | 'needs_you';

export interface ListConversationsInput {
  filter: ConversationFilter;
  q?: string | undefined;
  limit: number;
  /** The `lastActivityAt` of the last row already shown, for the next page. */
  before?: Date | undefined;
}

/**
 * A page of conversations, most recent activity first.
 *
 * Paged by time rather than by offset: on a busy afternoon new messages keep
 * arriving at the top, and an offset would skip or repeat rows as they did.
 *
 * Four queries a page however many conversations are on it — the customers,
 * the latest message each, when the shop last replied to each, and their
 * flagged messages. Loading every message to work this out would get slower
 * every day a shop stays on the product.
 */
export async function listConversations(
  businessId: string,
  input: ListConversationsInput,
): Promise<{ conversations: Conversation[]; nextBefore: Date | null }> {
  const search = input.q?.trim();
  const digits = search?.replace(/\D/g, '') ?? '';

  const customers = await prisma.customer.findMany({
    where: {
      businessId,
      deletedAt: null,
      messages: { some: {} },
      ...(input.before ? { lastInteractionAt: { lt: input.before } } : {}),
      ...(input.filter === 'needs_you'
        ? { AND: [{ messages: { some: { direction: 'INBOUND', requiresReview: true } } }] }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              ...(digits.length >= 3 ? [{ waNumber: { contains: digits } }] : []),
            ],
          }
        : {}),
    },
    // NULLS LAST explicitly: Postgres puts nulls FIRST in a descending sort, so
    // customers with no recorded activity would otherwise sit at the top of the
    // inbox above everyone who messaged today.
    orderBy: [{ lastInteractionAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    // One extra to learn whether another page exists without a count query.
    take: input.limit + 1,
    select: { id: true, name: true, waNumber: true, lastInteractionAt: true },
  });

  const page = customers.slice(0, input.limit);
  const ids = page.map((customer) => customer.id);

  if (ids.length === 0) return { conversations: [], nextBefore: null };

  const [latestRows, outboundRows, flaggedRows] = await Promise.all([
    // DISTINCT ON through Prisma: the newest message per customer.
    prisma.message.findMany({
      where: { businessId, customerId: { in: ids } },
      orderBy: [{ customerId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['customerId'],
      select: {
        customerId: true,
        body: true,
        direction: true,
        createdAt: true,
        sentFromApp: true,
        sentByStaffId: true,
      },
    }),
    prisma.message.groupBy({
      by: ['customerId'],
      where: { businessId, customerId: { in: ids }, direction: 'OUTBOUND' },
      _max: { createdAt: true },
    }),
    prisma.message.findMany({
      where: { businessId, customerId: { in: ids }, direction: 'INBOUND', requiresReview: true },
      select: { customerId: true, createdAt: true },
    }),
  ]);

  const latestBy = new Map(latestRows.map((row) => [row.customerId, row]));
  const outboundBy = new Map(outboundRows.map((row) => [row.customerId, row._max.createdAt]));
  const flaggedBy = new Map<string, Date[]>();
  for (const row of flaggedRows) {
    if (!row.customerId) continue;
    const list = flaggedBy.get(row.customerId) ?? [];
    list.push(row.createdAt);
    flaggedBy.set(row.customerId, list);
  }

  const conversations = page.map((customer) =>
    summariseConversation({
      customer,
      latest: latestBy.get(customer.id) ?? null,
      lastOutboundAt: outboundBy.get(customer.id) ?? null,
      flaggedInboundAt: flaggedBy.get(customer.id) ?? [],
    }),
  );

  // The needs_you filter above is only a candidate set: a customer with any
  // flagged message ever. Whether it is still unanswered is known only once
  // the reply times are in, so the final cut happens here.
  const filtered =
    input.filter === 'needs_you' ? conversations.filter((row) => row.needsYou) : conversations;

  const last = page[page.length - 1];
  return {
    conversations: filtered,
    nextBefore: customers.length > input.limit && last ? last.lastInteractionAt : null,
  };
}

/**
 * How many conversations are waiting on the owner, for the sidebar badge.
 *
 * Built on `summariseConversation` so the badge and the inbox answer the same
 * question the same way — they cannot disagree, because they are the same
 * function. They did disagree before: the badge counted every message ever
 * flagged, outbound ones included, answered or not, and read 39 in a shop
 * whose inbox had nothing waiting.
 *
 * It counts PEOPLE, not messages. Three unanswered messages from one customer
 * is one person to get back to.
 */
export async function countConversationsNeedingYou(businessId: string): Promise<number> {
  const flagged = await prisma.message.findMany({
    where: { businessId, direction: 'INBOUND', requiresReview: true, customerId: { not: null } },
    select: { customerId: true, createdAt: true },
  });

  if (flagged.length === 0) return 0;

  const flaggedBy = new Map<string, Date[]>();
  for (const row of flagged) {
    if (!row.customerId) continue;
    const list = flaggedBy.get(row.customerId) ?? [];
    list.push(row.createdAt);
    flaggedBy.set(row.customerId, list);
  }

  const replies = await prisma.message.groupBy({
    by: ['customerId'],
    where: { businessId, direction: 'OUTBOUND', customerId: { in: [...flaggedBy.keys()] } },
    _max: { createdAt: true },
  });
  const lastReplyBy = new Map(replies.map((row) => [row.customerId, row._max.createdAt]));

  let waiting = 0;
  for (const [customerId, flaggedInboundAt] of flaggedBy) {
    const row = summariseConversation({
      customer: { id: customerId, name: null, waNumber: '', lastInteractionAt: null },
      latest: null,
      lastOutboundAt: lastReplyBy.get(customerId) ?? null,
      flaggedInboundAt,
    });
    if (row.needsYou) waiting += 1;
  }
  return waiting;
}

export interface ThreadMessage {
  id: string;
  body: string | null;
  type: string;
  fromShop: boolean;
  /**
   * Who on the shop side sent it, where that is actually recorded. `phone`
   * means the owner replied from the WhatsApp app on their own phone; `staff`
   * means a staff member replied from the dashboard. `null` covers both the
   * assistant and the owner replying from the dashboard: the owner has no staff
   * record, so the database cannot currently tell those two apart, and guessing
   * would label a person's words as the machine's or the reverse.
   */
  sentBy: 'phone' | 'staff' | null;
  needsYou: boolean;
  /**
   * A reply the assistant wrote for this customer message and is holding for
   * the owner to approve, or null. This is how DRAFT_ONLY shops work at all —
   * the assistant proposes, the owner sends — so a thread without it would
   * leave those shops with a blank box where their suggestion used to be.
   */
  draft: string | null;
  createdAt: Date;
}

/** How far back a thread reaches. Older history is not what an owner is replying to. */
const THREAD_LIMIT = 200;

/**
 * One customer's conversation, oldest first so it reads top to bottom.
 *
 * The customer is checked against the business before any message is read,
 * so a guessed id from another shop returns 404 rather than an empty thread
 * that would confirm the id exists.
 */
export async function getThread(
  businessId: string,
  customerId: string,
): Promise<{
  customer: { id: string; name: string | null; waNumber: string };
  messages: ThreadMessage[];
}> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId, deletedAt: null },
    select: { id: true, name: true, waNumber: true },
  });

  if (!customer) throw new NotFoundError('Conversation not found');

  const rows = await prisma.message.findMany({
    where: { businessId, customerId },
    orderBy: { createdAt: 'desc' },
    take: THREAD_LIMIT,
    select: {
      id: true,
      body: true,
      type: true,
      direction: true,
      requiresReview: true,
      sentFromApp: true,
      sentByStaffId: true,
      aiReplyText: true,
      aiReplyStatus: true,
      createdAt: true,
    },
  });

  const lastOutbound = rows.find((row) => row.direction === 'OUTBOUND')?.createdAt ?? null;

  const messages: ThreadMessage[] = rows.reverse().map((row) => {
    const fromShop = row.direction === 'OUTBOUND';
    let sentBy: ThreadMessage['sentBy'] = null;
    if (fromShop && row.sentFromApp) sentBy = 'phone';
    else if (fromShop && row.sentByStaffId) sentBy = 'staff';

    return {
      id: row.id,
      body: row.body,
      type: row.type,
      fromShop,
      sentBy,
      needsYou:
        !fromShop &&
        row.requiresReview &&
        (lastOutbound === null || row.createdAt.getTime() > lastOutbound.getTime()),
      // Only a suggestion still waiting to be sent. One the owner already sent,
      // dismissed, or that was superseded is history, not something to offer.
      draft: !fromShop && row.aiReplyStatus === 'DRAFT' ? row.aiReplyText : null,
      createdAt: row.createdAt,
    };
  });

  return { customer, messages };
}
