import crypto from 'node:crypto';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { sendVerificationCodeEmail } from '../../services/email/transactional.js';

/**
 * Declared here rather than imported from the generated client.
 *
 * Prisma accepts the string literal, and keeping the union local means this
 * file compiles before `prisma generate` has been run, which is the state the
 * repo is in immediately after pulling a migration.
 */
export type OtpPurpose = 'EMAIL_VERIFICATION' | 'LOGIN';

/**
 * One-time codes, by email.
 *
 * The threat here is not a clever attacker, it is an ordinary one with a
 * script: six digits is a million possibilities, and at a thousand guesses a
 * second that is over in minutes. Nothing about the hash fixes that. What fixes
 * it is that a code dies after five wrong guesses, expires in ten minutes, and
 * can only be used once, so the attacker gets five tries per code and has to
 * wait a minute for the next one.
 *
 * Everything else here follows from that: the attempt counter is incremented
 * before the comparison, the comparison is constant-time, and a consumed code
 * is never re-checked.
 */

const CODE_DIGITS = 6;
const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** Stops the resend button being a free email cannon at someone else's inbox. */
const RESEND_COOLDOWN_SECONDS = 60;

export interface IssuedCode {
  /** When the current code stops working. */
  expiresAt: Date;
  /** False when email is not configured, so the caller can say so honestly. */
  delivered: boolean;
}

function generateCode(): string {
  // randomInt is uniform over the range. `randomBytes % 1000000` is not: the
  // low values come up slightly more often, which is exactly the bias a
  // brute-forcer would start from.
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function hashCode(code: string, businessId: string): string {
  // Keyed, and bound to the business: the same code issued to two accounts
  // produces two different digests, so a hash lifted from one row cannot be
  // replayed against another.
  return crypto
    .createHmac('sha256', Buffer.from(env.ENCRYPTION_KEY, 'hex'))
    .update(`${businessId}:${code}`)
    .digest('hex');
}

function matches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Issues a code and emails it.
 *
 * Any code still outstanding for the same purpose is consumed first. Two live
 * codes would double an attacker's budget per minute, and it is also what
 * people expect: the newest email is the one that works.
 */
export async function issueEmailOtp(
  businessId: string,
  purpose: OtpPurpose,
): Promise<IssuedCode> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { email: true, ownerName: true },
  });

  if (!business?.email) {
    throw new ValidationError('This account has no email address to send a code to.');
  }

  const recent = await prisma.emailOtp.findFirst({
    where: { businessId, purpose },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (recent) {
    const secondsSince = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (secondsSince < RESEND_COOLDOWN_SECONDS) {
      throw new ValidationError(
        `Wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSince)} seconds before asking for another code.`,
      );
    }
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

  await prisma.$transaction([
    prisma.emailOtp.updateMany({
      where: { businessId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.emailOtp.create({
      data: { businessId, purpose, codeHash: hashCode(code, businessId), expiresAt },
    }),
  ]);

  const delivered = await sendVerificationCodeEmail(
    business.email,
    business.ownerName,
    code,
    TTL_MINUTES,
  ).catch((error: unknown) => {
    logger.error({ error, businessId }, 'Verification code email failed');
    return false;
  });

  // The code itself is never logged. A code in the log file is a code in every
  // log aggregator the deployment ever ships to.
  logger.info({ businessId, purpose, delivered }, 'Email verification code issued');

  return { expiresAt, delivered };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'used' | 'no_code' | 'too_many' | 'wrong' };

/**
 * Checks a code, spending an attempt whether or not it is right.
 *
 * The attempt is recorded before the comparison rather than after, so a caller
 * who disconnects mid-request does not get a free guess.
 */
export async function verifyEmailOtp(
  businessId: string,
  purpose: OtpPurpose,
  code: string,
): Promise<VerifyResult> {
  const row = await prisma.emailOtp.findFirst({
    where: { businessId, purpose },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) return { ok: false, reason: 'no_code' };
  if (row.consumedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many' };

  await prisma.emailOtp.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });

  if (!matches(row.codeHash, hashCode(code.trim(), businessId))) {
    return { ok: false, reason: 'wrong' };
  }

  await prisma.$transaction([
    prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
    ...(purpose === 'EMAIL_VERIFICATION'
      ? [
          prisma.business.update({
            where: { id: businessId },
            data: { emailVerifiedAt: new Date() },
          }),
        ]
      : []),
  ]);

  return { ok: true };
}

/** Human wording for a failure, kept out of the route so it reads in one place. */
export function describeFailure(reason: Exclude<VerifyResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'expired':
      return 'That code has expired. Ask for a new one.';
    case 'used':
      return 'That code has already been used. Ask for a new one.';
    case 'no_code':
      return 'No code has been sent to this account yet.';
    case 'too_many':
      return 'Too many wrong tries. Ask for a new code.';
    case 'wrong':
      return 'That code is not right.';
    default:
      return 'That code could not be checked.';
  }
}

/**
 * Deletes codes that can no longer be used.
 *
 * Expired rows are evidence of nothing and accumulate forever otherwise. Called
 * from the same place the other housekeeping jobs run.
 */
export async function purgeExpiredOtps(): Promise<number> {
  const { count } = await prisma.emailOtp.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  return count;
}
