import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import { createPaystackCustomer } from '../../services/billing/paystack-customer.js';
import { businessSubject, revokeTokensFor } from '../../services/auth/revocation.js';
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

interface AccessTokenPayload {
  businessId: string;
  plan: BusinessPlan;
  staffId?: string;
  role?: StaffRole;
}

interface RefreshTokenPayload {
  businessId: string;
  jti: string;
}

function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
  });
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

  if (!business.active) {
    throw new UnauthorizedError('This account is inactive');
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
    logger.info({ email }, 'Password reset requested for unknown email — no action taken');
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
  await revokeTokensFor(businessSubject(claim.businessId));

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
  await revokeTokensFor(businessSubject(businessId));

  logger.info({ businessId }, 'Password changed');
}

/**
 * Rotates a refresh token. The presented token is always deleted, so a stolen
 * token is usable at most once and the legitimate holder's next refresh fails
 * visibly rather than silently sharing the session.
 */
export async function refreshTokens(rawRefreshToken: string): Promise<AuthTokens> {
  try {
    jwt.verify(rawRefreshToken, env.JWT_REFRESH_SECRET);
  } catch {
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
  await revokeTokensFor(businessSubject(businessId));
}
