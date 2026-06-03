import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database.js';
import { ForbiddenError, PlanLimitError } from '../utils/errors.js';

export async function attachBusinessContext(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    return;
  }

  const business = await prisma.business.findFirst({
    where: {
      id: request.user.businessId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      ownerName: true,
      phone: true,
      plan: true,
      trialEndsAt: true,
      suspendedAt: true,
      suspendReason: true,
      active: true,
      paystackSubCode: true,
    },
  });

  if (!business) {
    throw new ForbiddenError('Business not found');
  }

  if (!business.active) {
    throw new ForbiddenError('Business account is inactive');
  }

  if (business.suspendedAt) {
    throw new ForbiddenError(
      business.suspendReason
        ? `Business suspended: ${business.suspendReason}`
        : 'Business account is suspended',
    );
  }

  const now = new Date();
  const trialExpired = business.trialEndsAt && business.trialEndsAt < now;
  const hasActiveSubscription = !!business.paystackSubCode;

  if (trialExpired && !hasActiveSubscription) {
    throw new PlanLimitError('Trial has expired. Please upgrade your plan.');
  }

  request.business = {
    id: business.id,
    name: business.name,
    ownerName: business.ownerName,
    phone: business.phone,
    plan: business.plan,
    trialEndsAt: business.trialEndsAt,
    suspendedAt: business.suspendedAt,
    suspendReason: business.suspendReason,
    active: business.active,
    paystackSubCode: business.paystackSubCode,
  };
}
