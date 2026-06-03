import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { sendWhatsAppMessage } from '../../services/whatsapp/outbound.js';
import { logger } from '../../config/logger.js';
import type { InviteStaffInput, AcceptInviteInput, StaffLoginInput, UpdateStaffInput } from './staff.schema.js';
import * as repository from './staff.repository.js';
import { findBusinessById } from '../auth/auth.repository.js';
import { enforceStaffLimit } from '../../middleware/plan.middleware.js';

const SALT_ROUNDS = 12;

export async function inviteStaff(
  data: InviteStaffInput,
  businessId: string,
  businessName: string,
): Promise<repository.StaffMember> {
  const existing = await repository.findStaffByPhone(data.phone, businessId);
  if (existing) {
    throw new ValidationError('A staff member with this phone number already exists');
  }

  const currentStaff = await repository.listStaff(businessId);
  const limitCheck = await enforceStaffLimit(businessId, currentStaff.length);
  if (!limitCheck.allowed) {
    throw new ValidationError(
      `Staff limit reached (${limitCheck.limit} seats). Please upgrade your plan to add more staff.`,
    );
  }

  const inviteToken = crypto.randomUUID();
  const staff = await repository.createStaffInvite(data, businessId, inviteToken);

  const inviteUrl = `${env.FRONTEND_URL ?? 'https://app.flowdesk.io'}/staff/accept?token=${inviteToken}`;
  try {
    await sendWhatsAppMessage(
      data.phone,
      `You've been invited to manage ${businessName} on Flowdesk. Set up your access: ${inviteUrl}`,
      businessId,
    );
  } catch (error: unknown) {
    logger.error({ error, phone: data.phone }, 'Failed to send staff invite WhatsApp');
  }

  return staff;
}

export async function acceptInvite(data: AcceptInviteInput): Promise<repository.StaffMember> {
  const staff = await repository.findStaffByToken(data.token);
  if (!staff) {
    throw new NotFoundError('Invalid or expired invite token');
  }

  if (staff.inviteAcceptedAt) {
    throw new ValidationError('Invite has already been accepted');
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  return repository.acceptInvite(data.token, passwordHash);
}

export async function loginStaff(
  data: StaffLoginInput,
): Promise<{ accessToken: string; refreshToken: string; staff: repository.StaffMember }> {
  const staff = await repository.findStaffByPhone(data.phone, '');
  if (!staff || !staff.active) {
    throw new NotFoundError('Staff member not found or inactive');
  }

  if (!staff.passwordHash) {
    throw new ValidationError('Invite not yet accepted');
  }

  const valid = await bcrypt.compare(data.password, staff.passwordHash);
  if (!valid) {
    throw new ValidationError('Invalid credentials');
  }

  await repository.recordLogin(staff.id);

  const business = await findBusinessById(staff.businessId);

  const accessToken = jwt.sign(
    { businessId: business!.id, staffId: staff.id, role: staff.role, plan: business!.plan },
    env.JWT_SECRET,
    { expiresIn: '15m' },
  );

  const refreshToken = jwt.sign(
    { businessId: business!.id, staffId: staff.id, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' },
  );

  return { accessToken, refreshToken, staff };
}

export async function listStaff(businessId: string): Promise<repository.StaffMember[]> {
  return repository.listStaff(businessId);
}

export async function updateStaff(
  id: string,
  businessId: string,
  data: UpdateStaffInput,
): Promise<repository.StaffMember> {
  const existing = await repository.findStaffById(id, businessId);
  if (!existing) throw new NotFoundError('Staff member not found');
  return repository.updateStaff(id, businessId, data);
}

export async function getStaffActivity(staffId: string, businessId: string) {
  const staff = await repository.findStaffById(staffId, businessId);
  if (!staff) throw new NotFoundError('Staff member not found');
  return repository.getStaffActivity(staffId, businessId);
}
