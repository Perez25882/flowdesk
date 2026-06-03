import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';

interface BusinessPlanLimits {
  maxConversations: number;
  maxOrders: number;
  maxStaff: number;
  maxProducts: number;
}

const PLAN_LIMITS: Record<string, BusinessPlanLimits> = {
  STARTER: {
    maxConversations: 500,
    maxOrders: 300,
    maxStaff: 1,
    maxProducts: 50,
  },
  BUSINESS: {
    maxConversations: 2000,
    maxOrders: Number.POSITIVE_INFINITY,
    maxStaff: 5,
    maxProducts: Number.POSITIVE_INFINITY,
  },
  GROWTH: {
    maxConversations: 10000,
    maxOrders: Number.POSITIVE_INFINITY,
    maxStaff: 20,
    maxProducts: Number.POSITIVE_INFINITY,
  },
  ENTERPRISE: {
    maxConversations: Number.POSITIVE_INFINITY,
    maxOrders: Number.POSITIVE_INFINITY,
    maxStaff: Number.POSITIVE_INFINITY,
    maxProducts: Number.POSITIVE_INFINITY,
  },
  SUSPENDED: {
    maxConversations: 0,
    maxOrders: 0,
    maxStaff: 0,
    maxProducts: 0,
  },
};

interface BusinessWithPlan {
  id: string;
  plan: string;
  trialEndsAt: Date | null;
  suspendedAt: Date | null;
  monthlyConvoCount: number;
  monthlyOrderCount: number;
}

async function getBusinessPlanState(businessId: string): Promise<BusinessWithPlan | null> {
  return prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      plan: true,
      trialEndsAt: true,
      suspendedAt: true,
      monthlyConvoCount: true,
      monthlyOrderCount: true,
    },
  });
}

function isTrialExpired(trialEndsAt: Date | null): boolean {
  if (!trialEndsAt) return false;
  return new Date() > trialEndsAt;
}

function getEffectivePlan(business: BusinessWithPlan): string {
  if (business.suspendedAt) return 'SUSPENDED';
  if (isTrialExpired(business.trialEndsAt)) return 'SUSPENDED';
  return business.plan;
}

export function checkPlanLimit(
  business: BusinessWithPlan,
  limitType: keyof BusinessPlanLimits,
  currentUsage: number,
): { allowed: boolean; limit: number; remaining: number } {
  const effectivePlan = getEffectivePlan(business);
  const limits = PLAN_LIMITS[effectivePlan] ?? PLAN_LIMITS.SUSPENDED;
  const limit = limits![limitType];

  if (limit === Number.POSITIVE_INFINITY) {
    return { allowed: true, limit, remaining: Number.POSITIVE_INFINITY };
  }

  const remaining = limit - currentUsage;
  return { allowed: remaining > 0, limit, remaining };
}

export async function enforceConversationLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const businessId = request.business?.id;
  if (!businessId) return;

  const business = await getBusinessPlanState(businessId);
  if (!business) return;

  const effectivePlan = getEffectivePlan(business);
  if (effectivePlan === 'SUSPENDED') {
    reply.status(402).send({
      success: false,
      error: 'Account suspended. Please renew your subscription.',
      code: 'ACCOUNT_SUSPENDED',
    });
    return;
  }

  const { allowed } = checkPlanLimit(business, 'maxConversations', business.monthlyConvoCount);

  if (!allowed) {
    logger.warn({ businessId, plan: business.plan, usage: business.monthlyConvoCount }, 'Conversation limit exceeded');
    reply.status(402).send({
      success: false,
      error: 'Monthly conversation limit reached. Please upgrade your plan.',
      code: 'CONVERSATION_LIMIT_REACHED',
    });
  }
}

export async function enforceOrderLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const businessId = request.business?.id;
  if (!businessId) return;

  const business = await getBusinessPlanState(businessId);
  if (!business) return;

  const effectivePlan = getEffectivePlan(business);
  if (effectivePlan === 'SUSPENDED') {
    reply.status(402).send({
      success: false,
      error: 'Account suspended. Please renew your subscription.',
      code: 'ACCOUNT_SUSPENDED',
    });
    return;
  }

  const { allowed } = checkPlanLimit(business, 'maxOrders', business.monthlyOrderCount);

  if (!allowed) {
    logger.warn({ businessId, plan: business.plan, usage: business.monthlyOrderCount }, 'Order limit exceeded');
    reply.status(402).send({
      success: false,
      error: 'Monthly order limit reached. Please upgrade your plan.',
      code: 'ORDER_LIMIT_REACHED',
    });
  }
}

export async function enforceStaffLimit(
  businessId: string,
  currentStaffCount: number,
): Promise<{ allowed: boolean; limit: number; remaining: number }> {
  const business = await getBusinessPlanState(businessId);
  if (!business) {
    return { allowed: false, limit: 0, remaining: 0 };
  }

  const effectivePlan = getEffectivePlan(business);
  if (effectivePlan === 'SUSPENDED') {
    return { allowed: false, limit: 0, remaining: 0 };
  }

  return checkPlanLimit(business, 'maxStaff', currentStaffCount);
}

export async function enforceProductLimit(
  businessId: string,
  currentProductCount: number,
): Promise<{ allowed: boolean; limit: number; remaining: number }> {
  const business = await getBusinessPlanState(businessId);
  if (!business) {
    return { allowed: false, limit: 0, remaining: 0 };
  }

  const effectivePlan = getEffectivePlan(business);
  if (effectivePlan === 'SUSPENDED') {
    return { allowed: false, limit: 0, remaining: 0 };
  }

  return checkPlanLimit(business, 'maxProducts', currentProductCount);
}
