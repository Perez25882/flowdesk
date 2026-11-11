import { Prisma, type StaffRole } from '@prisma/client';
import { hasCapability, isAssignmentScoped, type Capability } from '@flowdesk/shared';
import type { FastifyRequest } from 'fastify';
import { prisma } from '../../config/database.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../utils/errors.js';

export interface OrderActor {
  businessId: string;
  staffId: string | null;
  role?: StaffRole | undefined;
}

export function orderActor(request: FastifyRequest): OrderActor {
  if (!request.user) throw new UnauthorizedError('Authentication required');
  return {
    businessId: request.user.businessId,
    staffId: request.user.staffId ?? null,
    role: request.user.role as StaffRole | undefined,
  };
}

export function orderActorHasCapability(actor: OrderActor, capability: Capability): boolean {
  if (actor.staffId === null) return actor.role === undefined;
  return !!actor.staffId && actor.role !== undefined && hasCapability(actor.role, capability);
}

export function orderAssignmentScope(actor: OrderActor): string | undefined {
  return actor.staffId !== null && isAssignmentScoped(actor.role) ? actor.staffId : undefined;
}

export function orderAccessWhere(
  orderId: string,
  actor: OrderActor,
  capability: 'orders.read' | 'orders.transition',
): { id: string; businessId: string; deletedAt: null; assignedStaffId?: string } {
  if (!orderActorHasCapability(actor, capability)) {
    throw new ForbiddenError('You do not have permission to perform this action');
  }

  const assignedStaffId = orderAssignmentScope(actor);
  return {
    id: orderId,
    businessId: actor.businessId,
    deletedAt: null,
    ...(assignedStaffId === undefined ? {} : { assignedStaffId }),
  } satisfies Prisma.OrderWhereInput;
}

export async function requireOrderAccess(
  orderId: string,
  actor: OrderActor,
  capability: 'orders.read' | 'orders.transition',
): Promise<void> {
  const where = orderAccessWhere(orderId, actor, capability);
  await requireStaffMembership(prisma, actor);
  const order = await prisma.order.findFirst({
    where,
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order not found');
}

export function requireOrderRouteAccess(capability: 'orders.read' | 'orders.transition') {
  return async (request: FastifyRequest): Promise<void> => {
    await requireOrderAccess((request.params as { id: string }).id, orderActor(request), capability);
  };
}

export async function lockOrderForDelivery(
  tx: Prisma.TransactionClient,
  orderId: string,
  actor: OrderActor,
): Promise<void> {
  const where = orderAccessWhere(orderId, actor, 'orders.transition');
  await requireStaffMembership(tx, actor);
  const assignment = where.assignedStaffId === undefined
    ? Prisma.empty
    : Prisma.sql`AND "assignedStaffId" = ${where.assignedStaffId}`;

  // PostgreSQL rechecks the predicate after a concurrent row update. Once
  // acquired, this lock also prevents reassignment until the mutation commits.
  const [order] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM orders
    WHERE id = ${where.id} AND "businessId" = ${where.businessId} AND "deletedAt" IS NULL
      ${assignment}
    FOR UPDATE
  `;
  if (!order) throw new NotFoundError('Order not found');
}

export async function requireStaffMembership(db: Prisma.TransactionClient, actor: OrderActor): Promise<void> {
  if (actor.staffId === null) return;
  if (!actor.staffId || actor.role === undefined) {
    throw new ForbiddenError('You do not have permission to perform this action');
  }

  const staff = await db.staff.findFirst({
    where: { id: actor.staffId, businessId: actor.businessId, active: true, role: actor.role },
    select: { id: true },
  });
  if (!staff) throw new ForbiddenError('You do not have permission to perform this action');
}
