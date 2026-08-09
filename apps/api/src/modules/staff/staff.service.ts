import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { enqueueOutboundMessage } from '../../queues/outbound.queue.js';
import { logger } from '../../config/logger.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import type { InviteStaffInput, AcceptInviteInput, StaffLoginInput, UpdateStaffInput } from './staff.schema.js';
import * as repository from './staff.repository.js';
import { findBusinessById } from '../auth/auth.repository.js';
import { issueTokens } from '../auth/auth.service.js';
import { checkStaffLimit } from '../../services/plan/plan.service.js';
import { revokeTokensFor, staffSubject } from '../../services/auth/revocation.js';

const SALT_ROUNDS = 12;

/**
 * A bcrypt hash of a throwaway value, compared against when no staff record
 * matches a login attempt, so the response time does not reveal whether a phone
 * number belongs to any Flowdesk business. Mirrors owner login.
 */
const DUMMY_HASH = bcrypt.hashSync('flowdesk-staff-timing-equalizer', SALT_ROUNDS);

import { toPublicStaff, type PublicStaff } from './staff.dto.js';
export { toPublicStaff, type PublicStaff };

export async function inviteStaff(
  data: InviteStaffInput,
  businessId: string,
  businessName: string,
): Promise<PublicStaff> {
  // Stored normalised so the number a manager types matches the number the
  // staff member later signs in with, in whatever format either wrote it.
  const phone = normalizeGhanaPhone(data.phone);
  const invite: InviteStaffInput = { ...data, phone };

  const existing = await repository.findStaffByPhone(phone, businessId);
  if (existing) {
    throw new ValidationError('A staff member with this phone number already exists');
  }

  const currentStaff = await repository.listStaff(businessId);
  const limitCheck = await checkStaffLimit(businessId, currentStaff.length);
  if (!limitCheck.allowed) {
    throw new ValidationError(
      `Staff limit reached (${limitCheck.limit} seats). Please upgrade your plan to add more staff.`,
    );
  }

  const inviteToken = crypto.randomUUID();
  const staff = await repository.createStaffInvite(invite, businessId, inviteToken);

  const frontend = (env.FRONTEND_URL ?? 'http://localhost:5173').split(',')[0]!.trim();
  const inviteUrl = `${frontend.replace(/\/$/, '')}/staff/accept?token=${inviteToken}`;

  try {
    // Sent from the business's own WhatsApp number, so the staff member
    // recognises the sender.
    await enqueueOutboundMessage({
      businessId,
      customerId: null,
      to: phone,
      body: `You've been invited to help manage ${businessName} on Flowdesk. Set up your access: ${inviteUrl}`,
    });
  } catch (error: unknown) {
    // The invite record exists regardless; the manager can resend the link.
    logger.error({ error, staffId: staff.id }, 'Failed to queue staff invite message');
  }

  return toPublicStaff(staff);
}

export async function acceptInvite(data: AcceptInviteInput): Promise<PublicStaff> {
  const staff = await repository.findStaffByToken(data.token);
  if (!staff) {
    throw new NotFoundError('Invalid or expired invite token');
  }

  if (staff.inviteAcceptedAt) {
    throw new ValidationError('Invite has already been accepted');
  }

  // The expiry was recorded at invite time but never checked, so a link stayed
  // valid forever. Invites go out as plain WhatsApp messages that get forwarded
  // and outlive the phone they were sent to, so the window has to be enforced.
  if (staff.inviteExpiry && staff.inviteExpiry < new Date()) {
    throw new ValidationError('This invite has expired. Ask your manager to send a new one.');
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  const accepted = await repository.acceptInvite(data.token, passwordHash);
  return toPublicStaff(accepted);
}

/**
 * Signs a staff member in with their phone number and password.
 *
 * There is no business context on this request, so the lookup spans every
 * business and the password decides which record is meant. Tokens are issued
 * through the shared auth path so a Session row exists and refresh works.
 */
export async function loginStaff(
  data: StaffLoginInput,
): Promise<{
  accessToken: string;
  refreshToken: string;
  business: { id: string; name: string };
  staff: PublicStaff;
}> {
  const phone = normalizeGhanaPhone(data.phone);
  const candidates = await repository.findActiveStaffByPhone(phone);

  let matched: repository.StaffMember | null = null;

  for (const candidate of candidates) {
    if (candidate.passwordHash && (await bcrypt.compare(data.password, candidate.passwordHash))) {
      matched = candidate;
      break;
    }
  }

  if (!matched) {
    // Equalise timing with the match path. Owner login runs a bcrypt compare
    // against a dummy hash for exactly this reason; staff login skipped it when
    // there were no candidates, so an unregistered phone returned in a few
    // milliseconds and a registered one took ~hundreds — a reliable oracle for
    // which numbers belong to a Flowdesk business.
    if (candidates.length === 0) {
      await bcrypt.compare(data.password, DUMMY_HASH);
    }
    // One message for "no such staff member" and "wrong password" alike, so the
    // endpoint cannot be used to discover who works where.
    throw new UnauthorizedError('Incorrect phone number or password');
  }

  const business = await findBusinessById(matched.businessId);

  if (!business) {
    throw new UnauthorizedError('This business account is no longer available');
  }

  await repository.recordLogin(matched.id);

  const tokens = await issueTokens(business.id, business.plan, {
    id: matched.id,
    role: matched.role,
  });

  logger.info({ staffId: matched.id, businessId: business.id }, 'Staff signed in');

  return {
    ...tokens,
    business: { id: business.id, name: business.name },
    staff: toPublicStaff(matched),
  };
}

export async function listStaff(businessId: string): Promise<PublicStaff[]> {
  const staff = await repository.listStaff(businessId);
  return staff.map(toPublicStaff);
}

export async function updateStaff(
  id: string,
  businessId: string,
  data: UpdateStaffInput,
): Promise<PublicStaff> {
  const existing = await repository.findStaffById(id, businessId);
  if (!existing) throw new NotFoundError('Staff member not found');

  const updated = await repository.updateStaff(id, businessId, data);

  // Deactivating a staff member, or downgrading their role, must take effect
  // immediately — not whenever their 15-minute access token happens to expire.
  // Kill their sessions so a fired employee (or a stolen phone) cannot keep
  // acting, and cannot mint fresh tokens via /auth/refresh.
  const deactivated = data.active === false && existing.active;
  const roleChanged = data.role !== undefined && data.role !== existing.role;

  if (deactivated || roleChanged) {
    await revokeStaffSessions(id);
  }

  return toPublicStaff(updated);
}

/**
 * Revokes a staff member's access immediately: deletes their refresh sessions
 * (so no new token can be minted) and bumps their revocation epoch (so any
 * access token already in hand stops working). Keyed by staff id, so only this
 * person is signed out, not the whole business.
 */
async function revokeStaffSessions(staffId: string): Promise<void> {
  await repository.deleteStaffSessions(staffId);
  await revokeTokensFor(staffSubject(staffId));
}

export async function getStaffActivity(
  staffId: string,
  businessId: string,
): Promise<repository.StaffActivityEntry[]> {
  const staff = await repository.findStaffById(staffId, businessId);
  if (!staff) throw new NotFoundError('Staff member not found');
  return repository.getStaffActivity(staffId, businessId);
}
