import { redis } from '../../config/redis.js';
import { logger } from '../../config/logger.js';

/**
 * Access-token revocation.
 *
 * Access tokens are stateless JWTs verified only by signature, so revoking a
 * refresh session did nothing to a token already issued — it stayed valid for
 * its full 15-minute life. After a password reset, a "log out everywhere", or a
 * staff member being deactivated, that window let a compromised or fired account
 * keep acting.
 *
 * The fix is a per-subject revocation epoch in Redis: bump it, and every token
 * issued before that moment is rejected in `requireAuth`. Owners are keyed by
 * business id; staff by staff id, so deactivating one rider does not sign out
 * the whole team.
 *
 * Fail-open by design: if Redis is unavailable the check is skipped rather than
 * locking everyone out. The refresh-token deletion is the durable backstop —
 * this only shortens the exposure of the short-lived access token.
 */

const PREFIX = 'flowdesk:revoked-before:';
// Comfortably longer than the access-token lifetime; a token older than this is
// already expired, so the marker can be dropped.
const TTL_SECONDS = 60 * 60;

function keyFor(subject: string): string {
  return `${PREFIX}${subject}`;
}

/** Business owner tokens are keyed by business id. */
export function businessSubject(businessId: string): string {
  return `biz:${businessId}`;
}

/** Staff tokens are keyed by staff id, so revocation is per-person. */
export function staffSubject(staffId: string): string {
  return `staff:${staffId}`;
}

/**
 * Marks every token for a subject issued at or before now as revoked.
 * Stored as epoch seconds; a one-second cushion covers tokens minted in the
 * same second as the revocation.
 */
export async function revokeTokensFor(subject: string): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) + 1;
  try {
    await redis.set(keyFor(subject), String(cutoff), 'EX', TTL_SECONDS);
  } catch (error: unknown) {
    logger.error({ error, subject }, 'Failed to record token revocation');
  }
}

/**
 * True when a token with this `iat` (issued-at, epoch seconds) has been revoked
 * for the subject. Returns false on any Redis error — see the fail-open note.
 */
export async function isTokenRevoked(subject: string, issuedAt: number | undefined): Promise<boolean> {
  if (issuedAt === undefined) return false;

  try {
    const raw = await redis.get(keyFor(subject));
    if (!raw) return false;
    return issuedAt < Number(raw);
  } catch (error: unknown) {
    logger.warn({ error, subject }, 'Revocation check unavailable — allowing token');
    return false;
  }
}
