import { Prisma, type StaffRole } from '@prisma/client';
import { hasCapability, type Capability } from '@flowdesk/shared';
import { prisma } from '../../config/database.js';
import { orderActorHasCapability, requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';

type Tx = Prisma.TransactionClient;
type Member = { id: string; name: string; role: StaffRole; inviteAcceptedAt: Date | null };
export type InboxActor = OrderActor;
export type InboxAssignment = { id: string; name: string } | null;
export type InboxState = { assignee: InboxAssignment; revision: number; unread: number; manuallyUnread: boolean;
  inboundPosition: string; readPosition: string; readRevision: number };

export const inboxReaderKey = (actor: InboxActor): string => actor.staffId ? `staff:${actor.staffId}` : 'owner';
const supervisor = (actor: InboxActor): boolean => orderActorHasCapability(actor, 'staff.manage');

export async function requireInboxRead(actor: InboxActor): Promise<void> {
  if (!orderActorHasCapability(actor, 'messages.read')) throw new ForbiddenError('Your role cannot access the inbox');
  await requireStaffMembership(prisma, actor);
}

const eligible = (role: StaffRole): boolean => hasCapability(role, 'messages.read') && hasCapability(role, 'messages.send');

async function lockMembers(tx: Tx, actor: InboxActor, target: string | null, capability: Capability): Promise<Member[]> {
  if (!orderActorHasCapability(actor, capability)) throw new ForbiddenError('Your role cannot change this conversation');
  const [business] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM businesses WHERE id = ${actor.businessId}
    AND active AND "deletedAt" IS NULL AND "suspendedAt" IS NULL AND "deactivatedAt" IS NULL FOR SHARE`;
  if (!business) throw new ForbiddenError('This business is unavailable');
  const ids = [actor.staffId, target].filter((id): id is string => id !== null);
  const members = ids.length ? await tx.$queryRaw<Member[]>`SELECT id, name, role::text, "inviteAcceptedAt" FROM staff
    WHERE "businessId" = ${actor.businessId} AND active AND id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE` : [];
  if (actor.staffId && !members.some((member) => member.id === actor.staffId && member.role === actor.role)) {
    throw new ForbiddenError('Your inbox permission changed');
  }
  return members;
}

async function lockThread(tx: Tx, businessId: string, customerId: string): Promise<{ inboundPosition: bigint; assignedStaffId: string | null; revision: number }> {
  const [customer] = await tx.$queryRaw<{ id: string }[]>`SELECT c.id FROM customers c WHERE c.id = ${customerId}
    AND c."businessId" = ${businessId} AND c."deletedAt" IS NULL AND EXISTS (
      SELECT 1 FROM messages m WHERE m."businessId" = ${businessId} AND m."customerId" = c.id
    ) FOR NO KEY UPDATE`;
  if (!customer) throw new NotFoundError('Conversation not found');
  await tx.inboxThread.createMany({ data: { businessId, customerId }, skipDuplicates: true });
  const [thread] = await tx.$queryRaw<{ inboundPosition: bigint; assignedStaffId: string | null; revision: number }[]>`
    SELECT "inboundPosition", "assignedStaffId", revision FROM inbox_threads
    WHERE "businessId" = ${businessId} AND "customerId" = ${customerId} FOR UPDATE`;
  if (!thread) throw new NotFoundError('Conversation not found');
  return thread;
}

export async function assignConversation(actor: InboxActor, customerId: string, requested: string | null, revision: number): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const members = await lockMembers(tx, actor, requested, 'messages.send');
    if (!supervisor(actor) && requested !== null && requested !== actor.staffId) throw new ForbiddenError('Only an owner or manager can assign another staff member');
    if (requested && !members.some((member) => member.id === requested && eligible(member.role) && member.inviteAcceptedAt)) {
      throw new NotFoundError('Eligible inbox staff member not found');
    }
    const thread = await lockThread(tx, actor.businessId, customerId);
    if (thread.assignedStaffId === requested) return false;
    if (thread.revision !== revision) throw new ConflictError('Assignment changed. Refresh the conversation before trying again.');
    if (!supervisor(actor) && thread.assignedStaffId && thread.assignedStaffId !== actor.staffId) {
      const member = await tx.staff.findFirst({ where: { id: thread.assignedStaffId, businessId: actor.businessId, active: true,
        inviteAcceptedAt: { not: null }, role: { in: ['MANAGER', 'OPERATIONS'] } }, select: { id: true } });
      if (member) throw new ConflictError('This conversation is assigned to another staff member');
    }
    const key = { businessId: actor.businessId, customerId };
    await tx.inboxThread.update({ where: { businessId_customerId: key }, data: { assignedStaffId: requested, revision: { increment: 1 } } });
    await tx.inboxAssignmentEvent.create({ data: { ...key, revision: revision + 1, actorStaffId: actor.staffId,
      previousStaffId: thread.assignedStaffId, assignedStaffId: requested } });
    return true;
  });
}

export async function recordInboxRead(actor: InboxActor, customerId: string, through: bigint | null, revision: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockMembers(tx, actor, null, 'messages.read');
    const thread = await lockThread(tx, actor.businessId, customerId);
    if (through !== null && through > thread.inboundPosition) throw new ValidationError('Reload the conversation before marking it read');
    const key = { businessId: actor.businessId, customerId, reader: inboxReaderKey(actor) };
    const current = await tx.inboxReader.findUnique({ where: { businessId_customerId_reader: key } });
    const position = current?.position ?? 0n;
    const manualUnread = through === null;
    const next = through !== null && through > position ? through : position;
    if (next === position && (current?.manualUnread ?? false) === manualUnread) return;
    if ((current?.revision ?? 0) !== revision) throw new ConflictError('Read state changed. Refresh the conversation before trying again.');
    await tx.inboxReader.upsert({ where: { businessId_customerId_reader: key },
      create: { ...key, position: next, manualUnread, revision: 1 },
      update: { position: next, manualUnread, revision: { increment: 1 } } });
  });
}

export async function inboxAssignees(actor: InboxActor): Promise<{ id: string; name: string }[]> {
  await requireInboxRead(actor);
  if (!supervisor(actor)) throw new ForbiddenError('Only an owner or manager can manage assignments');
  return prisma.staff.findMany({ where: { businessId: actor.businessId, active: true, role: { in: ['MANAGER', 'OPERATIONS'] },
    inviteAcceptedAt: { not: null } }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
}

export async function inboxStates(actor: InboxActor, ids: string[]): Promise<Map<string, InboxState>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; name: string | null; assignee: string | null; revision: number | null;
    inbound: bigint | null; position: bigint | null; manual: boolean | null; readRevision: number | null }[]>`
    SELECT c.id, s.name, s.id AS assignee, t.revision, t."inboundPosition" AS inbound,
      r.position, r."manualUnread" AS manual, r.revision AS "readRevision"
    FROM customers c LEFT JOIN inbox_threads t ON t."businessId" = c."businessId" AND t."customerId" = c.id
    LEFT JOIN staff s ON s.id = t."assignedStaffId" AND s."businessId" = c."businessId" AND s.active
      AND s."inviteAcceptedAt" IS NOT NULL AND s.role IN ('MANAGER','OPERATIONS')
    LEFT JOIN inbox_readers r ON r."businessId" = c."businessId" AND r."customerId" = c.id AND r.reader = ${inboxReaderKey(actor)}
    WHERE c."businessId" = ${actor.businessId} AND c."deletedAt" IS NULL AND c.id IN (${Prisma.join(ids)})`;
  return new Map(rows.map((row) => {
    const unread = (row.inbound ?? 0n) - (row.position ?? 0n);
    return [row.id, { assignee: row.assignee && row.name !== null ? { id: row.assignee, name: row.name } : null,
      revision: row.revision ?? 0, inboundPosition: String(row.inbound ?? 0n), readPosition: String(row.position ?? 0n),
      readRevision: row.readRevision ?? 0, manuallyUnread: row.manual ?? false, unread: Number(unread) }];
  }));
}

export async function unreadConversationCount(actor: InboxActor): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM inbox_threads t
    JOIN customers c ON c.id = t."customerId" AND c."businessId" = t."businessId" AND c."deletedAt" IS NULL
    LEFT JOIN inbox_readers r ON r."businessId" = t."businessId" AND r."customerId" = t."customerId" AND r.reader = ${inboxReaderKey(actor)}
    WHERE t."businessId" = ${actor.businessId} AND (t."inboundPosition" > coalesce(r.position, 0) OR r."manualUnread")`;
  return Number(row?.count ?? 0n);
}
