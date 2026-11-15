import type { CommerceCase, Prisma } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { requirePaymentActor } from '../payments/payment-relationships.js';
import type { caseInput } from './commerce.contract.js';
import type { z } from 'zod';
import { loadCommerceSource } from './commerce.quotes.js';

export async function updateCommerceCase(
  tx: Prisma.TransactionClient, actor: OrderActor, id: string, input: z.infer<typeof caseInput>,
): Promise<CommerceCase> {
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'messages.send');
  await requireStaffMembership(tx, actor);
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM commerce_cases WHERE id = ${id} AND "businessId" = ${actor.businessId} FOR UPDATE
  `;
  if (!locked) throw new NotFoundError('Case not found');
  const current = await tx.commerceCase.findUniqueOrThrow({ where: { id }, include: { order: { select: { status: true } } } });
  if (actor.role === 'OPERATIONS' && (input.staffId !== actor.staffId ||
      (current.assignedStaffId && current.assignedStaffId !== actor.staffId))) throw new ForbiddenError('Case assigned to other staff');
  if (current.revision !== input.revision || current.state === 'RESOLVED') throw new ConflictError('Case status changed');
  if (input.staffId) await requirePaymentActor(tx, actor.businessId, input.staffId, 'messages.send');
  if (input.state === 'ASSIGNED' && !input.staffId) throw new ValidationError('Choose an assigned staff member');
  if (input.state === 'RESOLVED') {
    if (input.resolution === 'CANCELLATION_CONFIRMED' && current.kind === 'CANCELLATION' && current.order?.status === 'CANCELLED') {
      // The verified order transition is the resolution evidence.
    } else if (input.resolution === 'CUSTOMER_CONFIRMED_RESOLUTION' && input.evidenceMessageId) {
      const source = await loadCommerceSource(tx, current, input.evidenceMessageId);
      if (+source.createdAt < +current.createdAt - 1000 || source.body?.trim().toUpperCase() !== ('RESOLVED ' + id).toUpperCase()) {
        throw new ConflictError('The message does not confirm this case');
      }
    } else throw new ConflictError('This case requires verified resolution evidence');
  } else if (input.resolution && (input.state !== 'ESCALATED' || input.resolution !== 'REFERRED_TO_OWNER')) {
    throw new ValidationError('Outcome requires confirmed resolution');
  }
  const resolution = input.resolution ?? null;
  const revision = current.revision + 1;
  return tx.commerceCase.update({ where: { id }, data: {
    state: input.state, assignedStaffId: input.staffId, resolution, revision,
    history: { create: { revision, state: input.state, staffId: actor.staffId, resolution,
      evidenceMessageId: input.evidenceMessageId ?? null } },
  } });
}
