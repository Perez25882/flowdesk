import type { Business, BusinessPlan, StaffRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

export interface CreateBusinessInput {
  name: string;
  ownerName: string;
  phone: string;
  plan?: BusinessPlan;
  trialEndsAt: Date;
  paystackCustomerId?: string;
}

export interface CreateSessionInput {
  businessId: string;
  staffId?: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
  deviceName?: string;
}

export interface SessionWithBusiness {
  id: string;
  businessId: string;
  staffId: string | null;
  refreshTokenHash: string;
  expiresAt: Date;
  business: {
    id: string;
    name: string;
    plan: BusinessPlan;
    active: boolean;
    trialEndsAt: Date | null;
    paystackSubCode: string | null;
    suspendedAt: Date | null;
  };
  staff: {
    id: string;
    role: StaffRole;
  } | null;
}

export async function createBusiness(data: CreateBusinessInput): Promise<Business> {
  const businessData: Prisma.BusinessCreateInput = {
    name: data.name,
    ownerName: data.ownerName,
    phone: data.phone,
    plan: data.plan ?? 'STARTER',
    trialEndsAt: data.trialEndsAt,
  };
  if (data.paystackCustomerId !== undefined) businessData.paystackCustomerId = data.paystackCustomerId;

  const business = await prisma.business.create({ data: businessData });

  return business;
}

export async function findBusinessByPhone(phone: string): Promise<Business | null> {
  return prisma.business.findFirst({
    where: {
      phone,
      deletedAt: null,
    },
  });
}

export async function findBusinessById(id: string): Promise<Pick<Business, 'id' | 'plan'> | null> {
  return prisma.business.findFirst({
    where: {
      id,
      deletedAt: null,
    },
    select: { id: true, plan: true },
  });
}

export async function createSession(data: CreateSessionInput): Promise<SessionWithBusiness> {
  const sessionData: Prisma.SessionUncheckedCreateInput = {
    businessId: data.businessId,
    staffId: data.staffId ?? null,
    refreshTokenHash: data.refreshTokenHash,
    expiresAt: data.expiresAt,
  };
  if (data.userAgent !== undefined) sessionData.userAgent = data.userAgent;
  if (data.ipAddress !== undefined) sessionData.ipAddress = data.ipAddress;
  if (data.deviceName !== undefined) sessionData.deviceName = data.deviceName;

  const session = await prisma.session.create({
    data: sessionData,
    include: {
      business: {
        select: {
          id: true,
          name: true,
          plan: true,
          active: true,
          trialEndsAt: true,
          paystackSubCode: true,
          suspendedAt: true,
        },
      },
      staff: {
        select: {
          id: true,
          role: true,
        },
      },
    },
  });

  return session as unknown as SessionWithBusiness;
}

export async function findSession(refreshTokenHash: string): Promise<SessionWithBusiness | null> {
  const session = await prisma.session.findFirst({
    where: {
      refreshTokenHash,
    },
    include: {
      business: {
        select: {
          id: true,
          name: true,
          plan: true,
          active: true,
          trialEndsAt: true,
          paystackSubCode: true,
          suspendedAt: true,
        },
      },
      staff: {
        select: {
          id: true,
          role: true,
        },
      },
    },
  });

  return session as unknown as SessionWithBusiness | null;
}

export async function deleteSession(refreshTokenHash: string): Promise<void> {
  await prisma.session.deleteMany({
    where: {
      refreshTokenHash,
    },
  });
}

export async function deleteAllSessions(businessId: string): Promise<void> {
  await prisma.session.deleteMany({
    where: {
      businessId,
    },
  });
}
