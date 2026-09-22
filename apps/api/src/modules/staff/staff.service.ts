import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '../../config/database.js';
import { env, features } from '../../config/env.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { enqueueOutboundMessage } from '../../queues/outbound.queue.js';
import { logger } from '../../config/logger.js';
import { sendStaffInviteEmail } from '../../services/email/transactional.js';
import { shouldSendAutoReply } from '../../services/templates/template-engine.js';
import { maskPhone, normalizeGhanaPhone } from '../../utils/phone.js';
import type { InviteStaffInput, AcceptInviteInput, StaffLoginInput, UpdateStaffInput } from './staff.schema.js';
import * as repository from './staff.repository.js';
import { findBusinessById } from '../auth/auth.repository.js';
import { issueTokens } from '../auth/auth.service.js';
import { checkStaffLimit } from '../../services/plan/plan.service.js';
import { revokeTokensFor, staffSubject } from '../../services/auth/revocation.js';
import {
  clearFailedLogins,
  isLoginLocked,
  MAX_FAILED_ATTEMPTS,
  recordFailedLogin,
} from '../../services/auth/login-throttle.js';

const SALT_ROUNDS = 12;

/**
 * A bcrypt hash of a throwaway value, compared against when no staff record
 * matches a login attempt, so the response time does not reveal whether a phone
 * number belongs to any Flowdesk business. Mirrors owner login.
 */
const DUMMY_HASH = bcrypt.hashSync('flowdesk-staff-timing-equalizer', SALT_ROUNDS);

import { toPublicStaff, type PublicStaff } from './staff.dto.js';
export { toPublicStaff, type PublicStaff };

/** A channel an invite was actually handed to. */
export type InviteDeliveryChannel = 'email' | 'whatsapp';

/**
 * What `inviteStaff` returns.
 *
 * Extends `PublicStaff` rather than wrapping it, so every existing caller keeps
 * reading the staff fields where it always did, and adds the two things the
 * Staff page could not previously show: the link itself, and an honest account
 * of which channels it left on.
 *
 * `toPublicStaff` strips `inviteToken` because a manager listing the roster
 * must not receive every colleague's live token. This response is a different
 * case: it goes only to the person who just created this one invite, and
 * handing them a link they can copy is the whole point — it is the only channel
 * that works when the new hire's WhatsApp window is shut and email is off.
 */
export interface StaffInviteResult extends PublicStaff {
  /** The accept-invite URL. Valid for seven days. */
  inviteUrl: string;
  /** Empty when nothing could be delivered and the link is the only path. */
  deliveredVia: InviteDeliveryChannel[];
}

function buildInviteUrl(inviteToken: string): string {
  const frontend = (env.FRONTEND_URL ?? 'http://localhost:5173').split(',')[0]!.trim();
  return `${frontend.replace(/\/$/, '')}/staff/accept?token=${inviteToken}`;
}

/**
 * Emails the invite link to the address the business registered.
 *
 * `Staff` has no email column, so that address is the owner's own: they get the
 * link and pass it on. Worth doing anyway, because it is the one copy of the
 * link that outlives the browser tab the invite was created in.
 *
 * Returns false — never throws — when email is switched off for this
 * deployment or the business never recorded an address, so the caller can say
 * the invite was not emailed rather than implying it was.
 */
async function deliverInviteByEmail(
  businessId: string,
  businessName: string,
  staffName: string,
  inviteToken: string,
): Promise<boolean> {
  if (!features.email) return false;

  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { email: true },
    });

    if (!business?.email) return false;

    return await sendStaffInviteEmail(business.email, businessName, inviteToken, staffName);
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Failed to email staff invite');
    return false;
  }
}

/**
 * Queues the invite as a WhatsApp text, but only when Meta will accept one.
 *
 * A new hire's number has by definition not messaged the shop, so the 24-hour
 * window has never opened for them. Sending free-form into a shut window comes
 * back as 131047, which `meta-errors.ts` classifies as non-retryable: the job
 * goes straight to the dead-letter queue and the invite silently never arrives.
 * That is what made every invite vanish. Checking the window first means the
 * owner is told to hand over the link instead of being told a message was sent
 * that never was.
 *
 * There is no template fallback here, unlike owner alerts. An invite carries a
 * one-time URL, and a Meta template can only carry one as the dynamic suffix of
 * a URL button — a template shaped around Flowdesk's own accept path, which
 * each tenant would have to create and get approved in their own WhatsApp
 * Business Account before a single employee could be hired. The copyable link
 * costs nothing and, for an owner standing next to their new hire, is faster.
 */
async function deliverInviteByWhatsApp(
  businessId: string,
  businessName: string,
  phone: string,
  inviteUrl: string,
): Promise<boolean> {
  try {
    const contact = await prisma.customer.findFirst({
      where: { businessId, waNumber: phone },
      select: { lastInboundAt: true },
    });

    if (!shouldSendAutoReply(contact?.lastInboundAt ?? null).withinWindow) {
      logger.info(
        { businessId, phone: maskPhone(phone) },
        'Staff invite not sent on WhatsApp: the 24-hour window for this number is closed',
      );
      return false;
    }

    // Sent from the business's own WhatsApp number, so the staff member
    // recognises the sender.
    await enqueueOutboundMessage({
      businessId,
      customerId: null,
      to: phone,
      body: `You've been invited to help manage ${businessName} on Flowdesk. Set up your access: ${inviteUrl}`,
    });

    return true;
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Failed to queue staff invite message');
    return false;
  }
}

export async function inviteStaff(
  data: InviteStaffInput,
  businessId: string,
  businessName: string,
): Promise<StaffInviteResult> {
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
  const inviteUrl = buildInviteUrl(inviteToken);

  // Both channels are attempted, and neither can fail the request: the staff
  // record exists either way, and the link comes back regardless of what got
  // through. Run in a fixed order rather than concurrently so the reported
  // channels are deterministic; both are bounded — the email call carries its
  // own timeout and the WhatsApp path only enqueues.
  const deliveredVia: InviteDeliveryChannel[] = [];

  if (await deliverInviteByEmail(businessId, businessName, data.name, inviteToken)) {
    deliveredVia.push('email');
  }

  if (await deliverInviteByWhatsApp(businessId, businessName, phone, inviteUrl)) {
    deliveredVia.push('whatsapp');
  }

  logger.info(
    { staffId: staff.id, businessId, phone: maskPhone(phone), deliveredVia },
    deliveredVia.length > 0
      ? 'Staff invite created and sent'
      : 'Staff invite created; no channel could deliver it, the link is the only path',
  );

  return { ...toPublicStaff(staff), inviteUrl, deliveredVia };
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

  // Checked before the attempt is made, so a locked-out attacker cannot keep
  // extending their own lockout and deny the real staff member access.
  if (await isLoginLocked(phone)) {
    throw new UnauthorizedError(
      'Too many failed sign-in attempts. Please try again in 15 minutes.',
    );
  }

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
    const failures = await recordFailedLogin(phone);

    if (failures >= MAX_FAILED_ATTEMPTS) {
      logger.warn({ phone: maskPhone(phone) }, 'Staff sign-in locked out after repeated failures');
    }

    // One message for "no such staff member" and "wrong password" alike, so the
    // endpoint cannot be used to discover who works where. The lockout message
    // above is the one exception, and it only ever appears to someone who has
    // already failed five times.
    throw new UnauthorizedError('Incorrect phone number or password');
  }

  await clearFailedLogins(phone);

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
