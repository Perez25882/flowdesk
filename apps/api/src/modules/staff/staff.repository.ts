import { prisma } from '../../config/database.js';
import { Prisma, StaffRole } from '@prisma/client';
import type { InviteStaffInput, UpdateStaffInput } from './staff.schema.js';

export interface StaffMember {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  /** Typed as the enum, not `string` — the role drives authorisation decisions. */
  role: StaffRole;
  active: boolean;
  passwordHash: string | null;
  inviteToken: string | null;
  /** Enforced on accept — an invite link outlives the message it was sent in. */
  inviteExpiry: Date | null;
  inviteAcceptedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export async function createStaffInvite(
  data: InviteStaffInput,
  businessId: string,
  inviteToken: string,
): Promise<StaffMember> {
  const staff = await prisma.staff.create({
    data: {
      businessId,
      name: data.name,
      phone: data.phone,
      role: data.role as StaffRole,
      inviteToken,
      inviteExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return staff as StaffMember;
}

export async function findStaffByToken(token: string): Promise<StaffMember | null> {
  const staff = await prisma.staff.findUnique({
    where: { inviteToken: token },
  });
  return staff as StaffMember | null;
}

export async function findStaffByPhone(phone: string, businessId: string): Promise<StaffMember | null> {
  const staff = await prisma.staff.findFirst({
    where: { phone, businessId },
  });
  return staff as StaffMember | null;
}

/**
 * Every active, onboarded staff record for a phone number, across all
 * businesses.
 *
 * Staff sign in with a phone number and no business context, and the same
 * person may work for more than one Flowdesk business, so the caller
 * disambiguates by password.
 */
export async function findActiveStaffByPhone(phone: string): Promise<StaffMember[]> {
  const staff = await prisma.staff.findMany({
    where: { phone, active: true, passwordHash: { not: null } },
  });
  return staff as StaffMember[];
}

export async function findStaffById(id: string, businessId: string): Promise<StaffMember | null> {
  const staff = await prisma.staff.findFirst({
    where: { id, businessId },
  });
  return staff as StaffMember | null;
}

export async function listStaff(businessId: string): Promise<StaffMember[]> {
  const staff = await prisma.staff.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
  });
  return staff as StaffMember[];
}

export async function updateStaff(
  id: string,
  businessId: string,
  data: UpdateStaffInput,
): Promise<StaffMember> {
  const updateData: Prisma.StaffUpdateInput = {};
  if (data.role !== undefined) updateData.role = data.role as StaffRole;
  if (data.active !== undefined) updateData.active = data.active;

  const staff = await prisma.staff.update({
    where: { id, businessId },
    data: updateData,
  });
  return staff as StaffMember;
}

export async function acceptInvite(
  token: string,
  passwordHash: string,
): Promise<StaffMember> {
  const staff = await prisma.staff.update({
    where: { inviteToken: token },
    data: {
      passwordHash,
      inviteAcceptedAt: new Date(),
      inviteToken: null,
      inviteExpiry: null,
    },
  });
  return staff as StaffMember;
}

export async function recordLogin(id: string): Promise<void> {
  await prisma.staff.update({
    where: { id },
    data: { lastLoginAt: new Date() },
  });
}

/** Deletes every refresh session belonging to a staff member. */
export async function deleteStaffSessions(staffId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { staffId } });
}

export interface StaffActivityEntry {
  id: string;
  staffId: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  note: string | null;
  createdAt: Date;
}

/** Most recent actions by a staff member, for the owner's activity log. */
export async function getStaffActivity(
  staffId: string,
  businessId: string,
): Promise<StaffActivityEntry[]> {
  return prisma.staffActivity.findMany({
    where: { staffId, staff: { businessId } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
