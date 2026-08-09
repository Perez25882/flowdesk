import type { Business, BusinessPlan, StaffRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

export interface CreateBusinessInput {
  name: string;
  ownerName: string;
  phone?: string | undefined;
  email: string;
  passwordHash: string;
  /** Set only once a Facebook account has been linked for WhatsApp access. */
  metaUserId?: string | undefined;
  plan?: BusinessPlan | undefined;
  trialEndsAt: Date;
  paystackCustomerId?: string | undefined;
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
    active?: boolean;
  } | null;
}

export async function createBusiness(data: CreateBusinessInput): Promise<Business> {
  const businessData: Prisma.BusinessCreateInput = {
    name: data.name,
    ownerName: data.ownerName,
    email: data.email,
    passwordHash: data.passwordHash,
    plan: data.plan ?? 'STARTER',
    trialEndsAt: data.trialEndsAt,
  };
  if (data.phone !== undefined) businessData.phone = data.phone;
  if (data.metaUserId !== undefined) businessData.metaUserId = data.metaUserId;
  if (data.paystackCustomerId !== undefined) {
    businessData.paystackCustomerId = data.paystackCustomerId;
  }

  return prisma.business.create({ data: businessData });
}

export async function findBusinessByEmail(email: string): Promise<Business | null> {
  return prisma.business.findFirst({
    where: {
      email: email.toLowerCase(),
      deletedAt: null,
    },
  });
}

export async function findBusinessByPhone(phone: string): Promise<Business | null> {
  return prisma.business.findFirst({
    where: {
      phone,
      deletedAt: null,
    },
  });
}

/**
 * Records a failed sign-in and applies a lockout once the threshold is reached.
 * Counting in the database rather than in memory means the limit survives a
 * restart and applies across every API instance.
 */
export async function registerFailedLogin(
  businessId: string,
  maxAttempts: number,
  lockDurationMs: number,
): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { failedLoginCount: true, lockedUntil: true },
  });

  // Defence in depth against the lock-extension DoS: if the account is already
  // locked, a further failed attempt must not push the expiry out. The service
  // layer rejects locked accounts before calling this, but a concurrent request
  // could still land here.
  if (business?.lockedUntil && business.lockedUntil > new Date()) {
    return;
  }

  const attempts = (business?.failedLoginCount ?? 0) + 1;

  await prisma.business.update({
    where: { id: businessId },
    data: {
      failedLoginCount: attempts,
      lockedUntil: attempts >= maxAttempts ? new Date(Date.now() + lockDurationMs) : null,
    },
  });
}

/** Clears the lockout counters after a successful sign-in. */
export async function registerSuccessfulLogin(businessId: string): Promise<void> {
  await prisma.business.update({
    where: { id: businessId },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });
}

export async function setBusinessPassword(
  businessId: string,
  passwordHash: string,
): Promise<void> {
  await prisma.business.update({
    where: { id: businessId },
    data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
  });
}

export async function createPasswordResetToken(
  businessId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  // Any earlier outstanding token is invalidated, so a reset link cannot be
  // resurrected after the owner requests a new one.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { businessId, usedAt: null } }),
    prisma.passwordResetToken.create({ data: { businessId, tokenHash, expiresAt } }),
  ]);
}

export async function consumePasswordResetToken(
  tokenHash: string,
): Promise<{ businessId: string } | null> {
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, businessId: true, expiresAt: true, usedAt: true },
  });

  if (!token || token.usedAt !== null || token.expiresAt < new Date()) {
    return null;
  }

  await prisma.passwordResetToken.update({
    where: { id: token.id },
    data: { usedAt: new Date() },
  });

  return { businessId: token.businessId };
}

export async function findBusinessByMetaUserId(metaUserId: string): Promise<Business | null> {
  return prisma.business.findFirst({
    where: {
      metaUserId,
      deletedAt: null,
    },
  });
}

export async function findBusinessById(
  id: string,
): Promise<Pick<Business, 'id' | 'plan' | 'name' | 'active' | 'suspendedAt'> | null> {
  return prisma.business.findFirst({
    where: {
      id,
      deletedAt: null,
    },
    select: { id: true, plan: true, name: true, active: true, suspendedAt: true },
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

/**
 * Atomically claims a refresh session: deletes the row and returns it, or null
 * if it was already gone.
 *
 * The old find-then-delete was a TOCTOU race — two concurrent refreshes with
 * the same token could both read the row before either deleted it, and both
 * were issued fresh tokens, defeating single-use rotation. `delete` on the
 * unique `refreshTokenHash` is atomic: exactly one caller wins, the rest get
 * P2025 and are treated as "already used".
 */
export async function consumeSession(
  refreshTokenHash: string,
): Promise<SessionWithBusiness | null> {
  try {
    const session = await prisma.session.delete({
      where: { refreshTokenHash },
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
        staff: { select: { id: true, role: true, active: true } },
      },
    });
    return session as unknown as SessionWithBusiness;
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return null;
    }
    throw error;
  }
}

export async function deleteAllSessions(businessId: string): Promise<void> {
  await prisma.session.deleteMany({
    where: {
      businessId,
    },
  });
}
