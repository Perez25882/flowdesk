import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import { createPaystackCustomer } from '../../services/billing/paystack-customer.js';
import { businessSubject, revokeTokensFor, staffSubject } from '../../services/auth/revocation.js';
import {
  signAccessToken as mintAccessToken,
  signRefreshToken as mintRefreshToken,
  verifyRefreshToken,
  type AccessTokenClaims,
  type RefreshTokenClaims,
} from '../../services/auth/tokens.js';
import type { BusinessPlan, StaffRole } from '../../types/prisma-enums.js';
import {
  createBusiness,
  findBusinessByEmail,
  consumeSession,
  createSession,
  deleteSession,
  deleteAllSessions,
  registerFailedLogin,
  registerSuccessfulLogin,
  setBusinessPassword,
  createPasswordResetToken,
  consumePasswordResetToken,
  type CreateBusinessInput,
  listStaffIdsForBusiness,
} from './auth.repository.js';
import type { LoginInput, RegisterInput } from './auth.schema.js';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;
const TRIAL_DAYS = 14;

/** bcrypt cost factor. 12 is the project's security baseline. */
const BCRYPT_ROUNDS = 12;

/** Failed sign-ins tolerated before the account is temporarily locked. */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * A bcrypt hash of a throwaway value, compared against when no account exists
 * for the submitted email. Without it, a missing account would return far
 * faster than a wrong password and the timing difference would let an attacker
 * enumerate which emails are registered.
 */
const DUMMY_HASH = bcrypt.hashSync('flowdesk-timing-equalizer', BCRYPT_ROUNDS);

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthenticatedBusiness {
  id: string;
  name: string;
  ownerName: string;
  email: string | null;
  plan: BusinessPlan;
  trialEndsAt: Date | null;
  waConnected: boolean;
}

export interface AuthResult extends AuthTokens {
  business: AuthenticatedBusiness;
}

type AccessTokenPayload = Omit<AccessTokenClaims, 'iat'>;

function signAccessToken(payload: AccessTokenPayload): string {
  return mintAccessToken(payload, ACCESS_TOKEN_EXPIRY);
}

function signRefreshToken(payload: Omit<RefreshTokenClaims, 'iat'>): string {
  return mintRefreshToken(payload, `${REFRESH_TOKEN_EXPIRY_DAYS}d`);
}

/** Refresh tokens are stored as SHA-256 digests so a database leak is not replayable. */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const REFRESH_CLAIM_PREFIX = 'flowdesk:refresh:claim:';
// Just long enough to cover the redemption; the session row is the durable
// record, this only serialises concurrent replays.
const REFRESH_CLAIM_TTL_SECONDS = 30;

/**
 * Atomically claims a refresh token for redemption. Returns false if it was
 * already claimed (a concurrent or replayed use). Fails OPEN on a Redis outage
 * — the DB session delete remains the correctness backstop, and locking every
 * refresh out during a Redis blip is worse than the narrow race it guards.
 */
async function claimRefreshToken(refreshTokenHash: string): Promise<boolean> {
  try {
    const result = await redis.set(
      `${REFRESH_CLAIM_PREFIX}${refreshTokenHash}`,
      '1',
      'EX',
      REFRESH_CLAIM_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  } catch (error: unknown) {
    logger.warn({ error }, 'Refresh-token claim unavailable — proceeding on DB guard alone');
    return true;
  }
}

function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Mints an access/refresh pair and records the session.
 *
 * Exported so staff sign-in issues sessions through exactly the same path as
 * owner sign-in — staff previously minted tokens by hand without creating a
 * Session row, so their refresh always failed and they were signed out after
 * fifteen minutes.
 */
export async function issueTokens(
  businessId: string,
  plan: BusinessPlan,
  staff?: { id: string; role: StaffRole },
): Promise<AuthTokens> {
  const accessPayload: AccessTokenPayload = { businessId, plan };
  if (staff) {
    accessPayload.staffId = staff.id;
    accessPayload.role = staff.role;
  }

  const accessToken = signAccessToken(accessPayload);
  const refreshToken = signRefreshToken({ businessId, jti: crypto.randomUUID() });

  const sessionInput: Parameters<typeof createSession>[0] = {
    businessId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: refreshExpiry(),
  };
  if (staff) sessionInput.staffId = staff.id;

  await createSession(sessionInput);

  return { accessToken, refreshToken };
}

function toAuthenticatedBusiness(business: {
  id: string;
  name: string;
  ownerName: string;
  email: string | null;
  plan: BusinessPlan;
  trialEndsAt: Date | null;
  waPhoneNumberId: string | null;
}): AuthenticatedBusiness {
  return {
    id: business.id,
    name: business.name,
    ownerName: business.ownerName,
    email: business.email,
    plan: business.plan,
    trialEndsAt: business.trialEndsAt,
    waConnected: business.waPhoneNumberId !== null,
  };
}

/**
 * Creates a business account. The owner can start working immediately; the
 * WhatsApp number is attached afterwards through the whatsapp module, so a
 * Meta outage never blocks sign-up.
 */
export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await findBusinessByEmail(input.email);

  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

  const createData: CreateBusinessInput = {
    name: input.businessName,
    ownerName: input.ownerName,
    email: input.email,
    passwordHash,
    trialEndsAt,
  };
  if (input.phone) createData.phone = normalizeGhanaPhone(input.phone);

  // Billing is set up opportunistically — a Paystack outage must not prevent
  // someone from creating an account during their free trial.
  const paystackCustomerId = await createPaystackCustomer(
    input.email,
    input.ownerName,
    createData.phone,
  ).catch((error: unknown) => {
    logger.warn({ error, email: input.email }, 'Paystack customer creation failed at signup');
    return undefined;
  });

  if (paystackCustomerId) createData.paystackCustomerId = paystackCustomerId;

  const business = await createBusiness(createData);
  const tokens = await issueTokens(business.id, business.plan);

  logger.info({ businessId: business.id }, 'Business registered');

  return { ...tokens, business: toAuthenticatedBusiness(business) };
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const business = await findBusinessByEmail(input.email);

  // Always run a bcrypt comparison so the response time does not reveal
  // whether the email is registered.
  const passwordMatches = await bcrypt.compare(
    input.password,
    business?.passwordHash ?? DUMMY_HASH,
  );

  // Locked accounts are rejected BEFORE recording another failure. The old
  // order recorded a failure on every wrong password and only checked the lock
  // afterwards, so anyone who knew the email could keep submitting wrong
  // passwords to roll the 15-minute lock forward indefinitely — a denial of
  // service against the real owner. Now, once locked, further attempts neither
  // extend the lock nor reach the counter.
  if (business?.lockedUntil && business.lockedUntil > new Date()) {
    throw new UnauthorizedError(
      'Too many failed sign-in attempts. Please try again in a few minutes.',
    );
  }

  if (!business || !business.passwordHash || !passwordMatches) {
    if (business) {
      await registerFailedLogin(business.id, MAX_LOGIN_ATTEMPTS, LOCKOUT_MS);
    }
    // Deliberately identical message for unknown email and wrong password.
    throw new UnauthorizedError('Incorrect email or password');
  }

  // A paused shop is the one "inactive" state the owner may sign in to — it is
  // the only place they can un-pause from, and a pause nobody can undo is a
  // deletion with extra steps. Signing in IS the resume, so the pause is
  // cleared here rather than behind a second button they would have to find.
  //
  // `active: false` still refuses, because that is the billing suspension,
  // which is ours rather than theirs and must not be undone by signing in.
  // A closed account needs no branch here: `findBusinessByEmail` filters on
  // `deletedAt: null`, so it is never found and falls out above with the same
  // "Incorrect email or password" as an unknown address — which is also the
  // right answer, since confirming a closed account existed tells a stranger
  // something about someone who has left.
  if (!business.active) {
    throw new UnauthorizedError('This account is inactive');
  }

  if (business.deactivatedAt) {
    await prisma.business.update({
      where: { id: business.id },
      data: { deactivatedAt: null },
    });
    logger.info({ businessId: business.id }, 'Owner signed back in — account resumed');
  }

  if (business.suspendedAt) {
    throw new UnauthorizedError(
      business.suspendReason
        ? `Account suspended: ${business.suspendReason}`
        : 'This account is suspended',
    );
  }

  await registerSuccessfulLogin(business.id);
  const tokens = await issueTokens(business.id, business.plan);

  logger.info({ businessId: business.id }, 'Business signed in');

  return { ...tokens, business: toAuthenticatedBusiness(business) };
}

/**
 * Issues a reset token. Always resolves successfully, whether or not the email
 * is registered, so the endpoint cannot be used to discover accounts.
 *
 * Returns the raw token so the caller can deliver it; only its hash is stored.
 */
export async function requestPasswordReset(email: string): Promise<string | null> {
  const business = await findBusinessByEmail(email);

  if (!business) {
    // The address is deliberately not logged. This endpoint is unauthenticated
    // and answers identically whether or not the account exists, so logging the
    // input would let anyone write arbitrary strings into the production log at
    // will — and would record the email addresses of people who are not even
    // customers.
    logger.info('Password reset requested for an unknown email — no action taken');
    return null;
  }

  const rawToken = crypto.randomBytes(32).toString('base64url');

  await createPasswordResetToken(
    business.id,
    hashToken(rawToken),
    new Date(Date.now() + RESET_TOKEN_TTL_MS),
  );

  logger.info({ businessId: business.id }, 'Password reset token issued');

  return rawToken;
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const claim = await consumePasswordResetToken(hashToken(rawToken));

  if (!claim) {
    throw new ValidationError('This reset link is invalid or has expired');
  }

  await setBusinessPassword(claim.businessId, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));

  // Every existing session is revoked: a password reset is the standard
  // response to a suspected compromise, so old sessions must not survive it.
  // Deleting sessions kills refresh; bumping the epoch kills any access token
  // already issued (they are stateless and would otherwise live out their 15
  // minutes).
  await deleteAllSessions(claim.businessId);
  await revokeEveryPrincipal(claim.businessId);

  logger.info({ businessId: claim.businessId }, 'Password reset completed');
}

export async function changePassword(
  businessId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { passwordHash: true },
  });

  if (!business?.passwordHash) {
    throw new ValidationError('This account has no password set');
  }

  if (!(await bcrypt.compare(currentPassword, business.passwordHash))) {
    throw new UnauthorizedError('Current password is incorrect');
  }

  await setBusinessPassword(businessId, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));
  await deleteAllSessions(businessId);
  await revokeEveryPrincipal(businessId);

  logger.info({ businessId }, 'Password changed');
}

/**
 * Confirms the caller is who they say before something irreversible.
 *
 * A signed-in session is not enough for pausing or closing a shop: the device
 * may be borrowed, lent to staff, or simply left open on a counter. Asking for
 * the password again is the difference between "someone had this laptop" and
 * "the owner decided this".
 */
async function requirePassword(businessId: string, password: string): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { passwordHash: true },
  });

  if (!business?.passwordHash) {
    throw new ValidationError('This account has no password set');
  }

  if (!(await bcrypt.compare(password, business.passwordHash))) {
    throw new UnauthorizedError('That password is not correct');
  }
}

/**
 * Pauses the shop. Reversible by signing in.
 *
 * Everything is kept — orders, customers, the catalogue, the conversation
 * history. What stops is the assistant: customers can still write, and nothing
 * answers them in the shop's name until the owner comes back. Sessions are
 * revoked so a device left signed in somewhere cannot quietly un-pause it just
 * by being used.
 */
export async function pauseAccount(businessId: string, password: string): Promise<void> {
  await requirePassword(businessId, password);

  await prisma.business.update({
    where: { id: businessId },
    data: { deactivatedAt: new Date() },
  });

  await deleteAllSessions(businessId);
  await revokeEveryPrincipal(businessId);

  logger.info({ businessId }, 'Owner paused the account');
}

/**
 * Closes the shop for good.
 *
 * Marks the account deleted and inactive, which sign-in refuses, then revokes
 * every session. The subscription is cancelled first: the one thing worse than
 * losing a customer is continuing to charge them after they have left.
 *
 * The rows are retained rather than erased. That is deliberate for now — orders
 * and payments are another party's financial record too — but it is NOT the
 * whole of what "delete my account" means under Ghana's Data Protection Act. A
 * purge of personal data after a retention window still has to be built.
 */
export async function closeAccount(businessId: string, password: string): Promise<void> {
  await requirePassword(businessId, password);

  await cancelSubscriptionForClosure(businessId);

  await prisma.business.update({
    where: { id: businessId },
    data: { deletedAt: new Date(), active: false },
  });

  await deleteAllSessions(businessId);
  await revokeEveryPrincipal(businessId);

  logger.info({ businessId }, 'Owner closed the account');
}

/**
 * Stops the billing before the account goes.
 *
 * Never throws: an account the owner has asked to close must close. A
 * subscription that could not be cancelled is a support ticket, not a reason to
 * keep someone inside a product they have left.
 */
async function cancelSubscriptionForClosure(businessId: string): Promise<void> {
  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { paystackSubCode: true },
    });

    if (!business?.paystackSubCode) return;

    const { fetchSubscription, disableSubscription } = await import(
      '../../services/billing/paystack.js'
    );
    const subscription = await fetchSubscription(business.paystackSubCode);
    if (!subscription) return;

    await disableSubscription(subscription.subscriptionCode, subscription.emailToken);
  } catch (error: unknown) {
    logger.error(
      { error, businessId },
      'Could not cancel the subscription while closing the account — cancel it by hand',
    );
  }
}

/**
 * Rotates a refresh token. The presented token is always deleted, so a stolen
 * token is usable at most once and the legitimate holder's next refresh fails
 * visibly rather than silently sharing the session.
 */
export async function refreshTokens(rawRefreshToken: string): Promise<AuthTokens> {
  // Type-asserting verification, not a bare signature check: an access token
  // presented here would otherwise pass the signature stage and be rejected
  // only later, by accident, when no session matched its hash.
  if (!verifyRefreshToken(rawRefreshToken)) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const refreshTokenHash = hashToken(rawRefreshToken);

  // Single-use enforcement via an atomic Redis claim on the token hash.
  //
  // A DB "delete-then-check" is not enough on its own here: Prisma compiles a
  // delete on a non-primary unique field into a select-then-delete, so several
  // concurrent replays can all read the row before any delete lands and each
  // gets issued a fresh session — proven live, 5 of 10 parallel replays won.
  // `SET NX` is atomic in Redis, so exactly one caller claims the token; the
  // rest are rejected. Same pattern as the SSE ticket.
  const claimed = await claimRefreshToken(refreshTokenHash);
  if (!claimed) {
    // Someone already redeemed this token. Delete the session too so the
    // legitimate holder's next attempt fails visibly rather than sharing it.
    await deleteSession(refreshTokenHash).catch(() => undefined);
    throw new UnauthorizedError('Session not found or revoked');
  }

  const session = await consumeSession(refreshTokenHash);

  if (!session) {
    throw new UnauthorizedError('Session not found or revoked');
  }

  if (session.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token expired');
  }

  if (!session.business.active || session.business.suspendedAt) {
    throw new UnauthorizedError('This account is no longer active');
  }

  // A staff member deactivated since this session was issued must not be able to
  // refresh into a fresh access token. (Their sessions are also deleted on
  // deactivation; this is the belt to that braces.)
  if (session.staff && session.staff.active === false) {
    throw new UnauthorizedError('This staff account is no longer active');
  }

  return issueTokens(
    session.business.id,
    session.business.plan,
    session.staff ? { id: session.staff.id, role: session.staff.role } : undefined,
  );
}

export async function logout(rawRefreshToken: string): Promise<void> {
  await deleteSession(hashToken(rawRefreshToken));
}

export async function logoutAllSessions(businessId: string): Promise<void> {
  await deleteAllSessions(businessId);
  // Also invalidate access tokens already issued, not just refresh sessions.
  await revokeEveryPrincipal(businessId);
}

/**
 * Bumps the revocation epoch for the business AND for each of its staff.
 *
 * `requireAuth` picks the subject per principal: an owner's token is checked
 * against `biz:<id>` but a staff token against `staff:<staffId>`. Revoking only
 * the business subject therefore left every staff member's access token valid
 * until it expired — up to fifteen minutes after the owner clicked "log out
 * everywhere" or reset a compromised password, which is exactly the window that
 * action exists to close.
 *
 * Best-effort by design: the sessions are already deleted by the caller, so a
 * failure here shortens the guarantee to the access-token lifetime rather than
 * leaving anyone signed in indefinitely. Failing the whole request instead
 * would mean a password reset that could not complete.
 */
async function revokeEveryPrincipal(businessId: string): Promise<void> {
  await revokeTokensFor(businessSubject(businessId));

  try {
    const staff = await listStaffIdsForBusiness(businessId);
    await Promise.all(staff.map((staffId) => revokeTokensFor(staffSubject(staffId))));
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Failed to revoke staff access tokens');
  }
}
