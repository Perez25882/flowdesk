import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { inboxReaderKey, inboxStates, type InboxActor, type InboxState } from './inbox-state.js';

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
}

export type SummariseInput = {
  customer: { id: string; name: string | null; waNumber: string; lastInteractionAt: Date | null };
  latest: LatestMessage | null;
} & ({ waiting: number } | { lastOutboundAt: Date | null; flaggedInboundAt: Date[] });

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
  const { customer, latest } = input;
  const waiting = 'waiting' in input ? input.waiting : input.flaggedInboundAt.filter((at) => !input.lastOutboundAt || at > input.lastOutboundAt).length;

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

export type ConversationFilter = 'all' | 'needs_you' | 'unread';

export interface ListConversationsInput {
  filter: ConversationFilter;
  q?: string | undefined;
  limit: number;
  /** The `lastActivityAt` of the last row already shown, for the next page. */
  before?: Date | undefined;
  cursor?: string | undefined;
  assignment: 'all' | 'assigned' | 'unassigned' | 'mine';
}

const needsReply = Prisma.sql`pending.direction = 'INBOUND' AND pending."requiresReview"
  AND NOT EXISTS (SELECT 1 FROM messages replied WHERE replied."businessId" = pending."businessId"
    AND replied."customerId" = pending."customerId" AND replied.direction = 'OUTBOUND' AND replied."createdAt" >= pending."createdAt")`;

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
  actor: InboxActor,
  input: ListConversationsInput,
): Promise<{ conversations: (Conversation & { inbox: InboxState | null })[]; nextBefore: Date | null; nextCursor: string | null }> {
  const { businessId } = actor;
  const search = input.q?.trim();
  const digits = search?.replace(/\D/g, '') ?? '';
  let cursor: { at: string | null; id: string } | null = null;
  if (input.cursor) {
    try {
      cursor = z.object({ at: z.string().datetime().nullable(), id: z.string().min(1).max(100) })
        .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
    } catch { throw new ValidationError('Invalid conversation cursor'); }
  }
  const date = cursor?.at ? new Date(cursor.at) : null;
  const position = cursor ? (date ? Prisma.sql`AND (c."lastInteractionAt" < ${date} OR c."lastInteractionAt" IS NULL
    OR (c."lastInteractionAt" = ${date} AND c.id < ${cursor.id}))` : Prisma.sql`AND c."lastInteractionAt" IS NULL AND c.id < ${cursor.id}`)
    : input.before ? Prisma.sql`AND c."lastInteractionAt" < ${input.before}` : Prisma.empty;
  const assignment = {
    all: Prisma.empty, assigned: Prisma.sql`AND s.id IS NOT NULL`, unassigned: Prisma.sql`AND s.id IS NULL`,
    mine: Prisma.sql`AND s.id = ${actor.staffId ?? ''}`,
  }[input.assignment];
  const filter = input.filter === 'unread' ? Prisma.sql`AND (t."inboundPosition" > coalesce(r.position, 0) OR r."manualUnread")`
    : input.filter === 'needs_you' ? Prisma.sql`AND EXISTS (SELECT 1 FROM messages pending WHERE pending."businessId" = c."businessId"
      AND pending."customerId" = c.id AND ${needsReply})` : Prisma.empty;
  const term = search ? Prisma.sql`AND (strpos(lower(c.name), lower(${search})) > 0
    ${digits.length >= 3 ? Prisma.sql`OR strpos(c."waNumber", ${digits}) > 0` : Prisma.empty})` : Prisma.empty;
  const customers = await prisma.$queryRaw<SummariseInput['customer'][]>`SELECT c.id, c.name, c."waNumber", c."lastInteractionAt"
    FROM customers c LEFT JOIN inbox_threads t ON t."businessId" = c."businessId" AND t."customerId" = c.id
    LEFT JOIN staff s ON s.id = t."assignedStaffId" AND s."businessId" = c."businessId" AND s.active
      AND s."inviteAcceptedAt" IS NOT NULL AND s.role IN ('MANAGER','OPERATIONS')
    LEFT JOIN inbox_readers r ON r."businessId" = c."businessId" AND r."customerId" = c.id AND r.reader = ${inboxReaderKey(actor)}
    WHERE c."businessId" = ${businessId} AND c."deletedAt" IS NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m."businessId" = c."businessId" AND m."customerId" = c.id)
      ${position} ${term} ${assignment} ${filter}
    ORDER BY c."lastInteractionAt" DESC NULLS LAST, c.id DESC LIMIT ${input.limit + 1}`;

  const page = customers.slice(0, input.limit);
  const ids = page.map((customer) => customer.id);

  if (ids.length === 0) return { conversations: [], nextBefore: null, nextCursor: null };

  const [latestRows, pending, states] = await Promise.all([
    prisma.$queryRaw<(LatestMessage & { customerId: string })[]>`SELECT DISTINCT ON ("customerId")
      "customerId", body, direction::text, "createdAt" FROM messages
      WHERE "businessId" = ${businessId} AND "customerId" IN (${Prisma.join(ids)})
      ORDER BY "customerId", "createdAt" DESC, id DESC`,
    prisma.$queryRaw<{ customerId: string; count: bigint }[]>`SELECT pending."customerId", count(*) FROM messages pending
      WHERE pending."businessId" = ${businessId} AND pending."customerId" IN (${Prisma.join(ids)}) AND ${needsReply}
      GROUP BY pending."customerId"`,
    inboxStates(actor, ids),
  ]);

  const latestBy = new Map(latestRows.map((row) => [row.customerId, row]));
  const waitingBy = new Map(pending.map((row) => [row.customerId, Number(row.count)]));

  const conversations = page.map((customer) => ({
    ...summariseConversation({
      customer,
      latest: latestBy.get(customer.id) ?? null,
      waiting: waitingBy.get(customer.id) ?? 0,
    }), inbox: states.get(customer.id) ?? null,
  }));

  const last = customers.length > input.limit ? page.at(-1) : undefined;
  return {
    conversations,
    nextBefore: last?.lastInteractionAt ?? null,
    nextCursor: last ? Buffer.from(JSON.stringify({ at: last.lastInteractionAt, id: last.id })).toString('base64url') : null,
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
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(DISTINCT pending."customerId") FROM messages pending
    JOIN customers c ON c."businessId" = pending."businessId" AND c.id = pending."customerId" AND c."deletedAt" IS NULL
    WHERE pending."businessId" = ${businessId} AND ${needsReply}`;
  return Number(row?.count ?? 0n);
}

export interface ThreadMessage {
  hasAttachment?: boolean;
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
  deliveryState?: string;
}

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
  beforeId?: string,
): Promise<{
  customer: { id: string; name: string | null; waNumber: string };
  messages: ThreadMessage[];
  nextBefore: string | null;
}> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId, deletedAt: null },
    select: { id: true, name: true, waNumber: true },
  });

  if (!customer) throw new NotFoundError('Conversation not found');

  const scope = { businessId, customerId };
  const before = beforeId ? await prisma.message.findFirst({ where: { ...scope, id: beforeId }, select: { id: true, createdAt: true } }) : null;
  if (beforeId && !before) throw new NotFoundError('Conversation history was not found');
  const [history, lastReply, pending] = await Promise.all([
    prisma.message.findMany({
    where: { ...scope, ...(before ? { OR: [{ createdAt: { lt: before.createdAt } },
      { createdAt: before.createdAt, id: { lt: before.id } }] } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: THREAD_LIMIT + 1,
    select: {
      id: true,
      body: true,
      type: true,
      direction: true,
      requiresReview: true,
      sentFromApp: true,
      sentByStaffId: true,
      aiReplyText: true,
      mediaKey: true,
      aiReplyStatus: true,
      waMessageId: true,
      createdAt: true,
    },
    }),
    prisma.message.findFirst({ where: { ...scope, direction: 'OUTBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    before ? [] : prisma.whatsAppSend.findMany({
      where: { businessId, providerMessageId: null, payload: { path: ['customerId'], equals: customerId } },
      orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, state: true, payload: true, createdAt: true },
    }),
  ]);
  const rows = history.slice(0, THREAD_LIMIT);
  const nextBefore = history.length > THREAD_LIMIT ? rows.at(-1)!.id : null;
  const outboundIds = rows.filter((row) => row.direction === 'OUTBOUND').map((row) => row.waMessageId);
  const sends = outboundIds.length ? await prisma.whatsAppSend.findMany({
    where: { businessId, providerMessageId: { in: outboundIds }, payload: { path: ['customerId'], equals: customerId } },
    select: { providerMessageId: true, state: true },
  }) : [];
  const providerIds = new Map(sends.map((send) => [send.providerMessageId, send.state]));

  const messages: ThreadMessage[] = rows.reverse().map((row) => {
    const fromShop = row.direction === 'OUTBOUND';
    const deliveryState = fromShop ? providerIds.get(row.waMessageId) : undefined;
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
        (!lastReply || row.createdAt > lastReply.createdAt),
      // Only a suggestion still waiting to be sent. One the owner already sent,
      // dismissed, or that was superseded is history, not something to offer.
      draft: !fromShop && row.aiReplyStatus === 'DRAFT' ? row.aiReplyText : null,
      ...(row.mediaKey ? { hasAttachment: true } : {}),
      ...(deliveryState ? { deliveryState } : {}),
      createdAt: row.createdAt,
    };
  });

  for (const send of pending) {
    if (!send.payload || typeof send.payload !== 'object' || Array.isArray(send.payload) ||
        typeof send.payload.body !== 'string') continue;
    messages.push({ id: send.id, body: send.payload.body, type: 'TEXT', fromShop: true,
      sentBy: typeof send.payload.sentByStaffId === 'string' ? 'staff' : null,
      needsYou: false, draft: null, createdAt: send.createdAt, deliveryState: send.state });
  }
  return { customer, nextBefore, messages: messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) };
}
