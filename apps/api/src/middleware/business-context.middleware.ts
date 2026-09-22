import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database.js';
import { ForbiddenError, PlanLimitError } from '../utils/errors.js';
import { TRIAL_GRACE_MS } from '../services/plan/plan.service.js';

/**
 * Routes that stay open to a business whose trial has run out.
 *
 * This hook is registered on the whole protected sub-app, so a bare 402 on
 * trial expiry closed the billing endpoints too — the customer who wanted to
 * pay could not reach checkout, which is the one door every converting trial
 * has to walk through. It also locked them out of changing their own password
 * and of reading the account they are being asked to pay for.
 *
 * Everything here is either how they pay, or how they see what they are paying
 * for. Nothing here writes business data.
 */
const OPEN_AFTER_TRIAL = [
  '/api/v1/billing/',
  '/api/v1/settings/business',
  '/api/v1/auth/',
  '/api/v1/dashboard/summary',
];

function isAllowedAfterTrial(request: FastifyRequest): boolean {
  // Matched on the raw url rather than the route pattern because this runs as a
  // preHandler on the encapsulated sub-app, where `routeOptions.url` is not yet
  // resolved for every path shape.
  const path = request.url.split('?')[0] ?? '';

  if (OPEN_AFTER_TRIAL.some((prefix) => path.startsWith(prefix))) {
    return true;
  }

  // Reads stay open so the owner can still see their orders and customers while
  // deciding. Writes are what stop. "Nothing is deleted, the account goes
  // read-only" is what the landing page promises, and this is what makes that
  // true.
  return request.method === 'GET' || request.method === 'HEAD';
}

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
      email: true,
      plan: true,
      trialEndsAt: true,
      suspendedAt: true,
      suspendReason: true,
      active: true,
      paystackSubCode: true,
      paystackCustomerId: true,
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
  const hasActiveSubscription = !!business.paystackSubCode;
  const trialExpired =
    !!business.trialEndsAt && business.trialEndsAt.getTime() + TRIAL_GRACE_MS < now.getTime();

  if (trialExpired && !hasActiveSubscription && !isAllowedAfterTrial(request)) {
    throw new PlanLimitError(
      'Your free trial has ended. Choose a plan to carry on using Flowdesk — your data is all still here.',
    );
  }

  request.business = {
    id: business.id,
    name: business.name,
    ownerName: business.ownerName,
    phone: business.phone,
    email: business.email,
    plan: business.plan,
    trialEndsAt: business.trialEndsAt,
    suspendedAt: business.suspendedAt,
    suspendReason: business.suspendReason,
    active: business.active,
    paystackSubCode: business.paystackSubCode,
    paystackCustomerId: business.paystackCustomerId,
  };
}
