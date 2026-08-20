import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';

/**
 * Failed-attempt lockout for staff sign-in.
 *
 * The owner's account carries `failedLoginCount` and `lockedUntil` columns and
 * `auth.service.ts` enforces a five-attempt lockout against them. Staff have no
 * such columns, so staff sign-in had nothing but a per-IP route limit standing
 * in front of it — and `findActiveStaffByPhone` deliberately searches across
 * every business, so an attacker needs only a Ghanaian phone number and a
 * password guess, with no idea which shop the person works for. Staff passwords
 * have a ten-character minimum and no complexity rule, on accounts the role
 * matrix itself describes as living on "a borrowed or lost phone".
 *
 * Redis rather than a migration: the counter is short-lived, worthless if lost,
 * and wants a TTL — which is what Redis is for, and it keeps the fix out of the
 * schema.
 *
 * Fails OPEN. Locking every staff member out of the product because Redis
 * blipped is a worse outage than the brute-force window it would close, and the
 * per-IP route limit still applies underneath. Every fail-open is logged at
 * error so it is visible rather than silent.
 */

const KEY_PREFIX = 'flowdesk:staff-login:fails:';

/** Attempts allowed before the lockout engages. Matches the owner path. */
export const MAX_FAILED_ATTEMPTS = 5;

/** How long a lockout lasts, and how long a partial failure streak is remembered. */
export const LOCKOUT_WINDOW_SECONDS = 15 * 60;

function keyFor(identifier: string): string {
  return `${KEY_PREFIX}${identifier}`;
}

/**
 * Whether this identifier is currently locked out.
 *
 * Checked BEFORE the attempt is recorded, deliberately. Recording first and
 * checking after would let an attacker who is already locked out keep pushing
 * the expiry forward with every request, turning their own lockout into an
 * indefinite denial of service against the legitimate user. `auth.service.ts`
 * orders the owner path the same way and says so.
 */
export async function isLoginLocked(identifier: string): Promise<boolean> {
  try {
    const raw = await redis.get(keyFor(identifier));
    return raw !== null && Number(raw) >= MAX_FAILED_ATTEMPTS;
  } catch (error: unknown) {
    logger.error({ error }, 'Staff login lockout check failed — allowing the attempt');
    return false;
  }
}

/**
 * Records a failed attempt and returns the running count.
 *
 * The TTL is set from the first failure and not extended by later ones, so a
 * streak expires fifteen minutes after it started rather than fifteen minutes
 * after the attacker stops — which is what makes the lockout a fixed window
 * instead of something an attacker can hold open.
 */
export async function recordFailedLogin(identifier: string): Promise<number> {
  try {
    const key = keyFor(identifier);
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, LOCKOUT_WINDOW_SECONDS);
    }

    return count;
  } catch (error: unknown) {
    logger.error({ error }, 'Staff login failure could not be recorded');
    return 0;
  }
}

/** Clears the streak. Called on a successful sign-in. */
export async function clearFailedLogins(identifier: string): Promise<void> {
  try {
    await redis.del(keyFor(identifier));
  } catch (error: unknown) {
    logger.error({ error }, 'Staff login failure counter could not be cleared');
  }
}
