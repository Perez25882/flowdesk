import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';

/**
 * Refresh-token transport.
 *
 * The refresh token is the long-lived credential — 30 days — so it is the one
 * worth stealing. Keeping it in `localStorage` meant any successful XSS handed
 * an attacker a month of access that surviving a password change required
 * explicit revocation. It now lives in a cookie JavaScript cannot read.
 *
 * The short-lived access token stays in memory on the client and travels in the
 * `Authorization` header. That split is what keeps the API immune to CSRF:
 * every business endpoint requires an explicit header, which a cross-site form
 * or image cannot set, so no ambient credential authorises anything. Only
 * `/auth/refresh` and `/auth/logout` read the cookie, and those are additionally
 * protected by `SameSite=Strict`.
 */

export const REFRESH_COOKIE_NAME = 'flowdesk_refresh';

/**
 * Scoping the cookie to the auth path means it is not attached to ordinary API
 * calls, so it cannot leak through a logging proxy or an unrelated handler.
 */
const COOKIE_PATH = '/api/v1/auth';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function cookieOptions() {
  return {
    httpOnly: true,
    // Strict rather than Lax: there is no legitimate cross-site navigation that
    // should carry this cookie, and Lax would still send it on top-level GETs.
    sameSite: 'strict' as const,
    // Secure requires HTTPS, which local development does not use.
    secure: env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    maxAge: THIRTY_DAYS_SECONDS,
  };
}

export function setRefreshCookie(reply: FastifyReply, refreshToken: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions());
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: COOKIE_PATH });
}

/**
 * Reads the refresh token, preferring the cookie.
 *
 * The request body is still accepted as a fallback so non-browser clients and
 * any session issued before this change keep working through their next
 * rotation.
 */
export function readRefreshToken(
  request: FastifyRequest,
  bodyToken?: string | undefined,
): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[REFRESH_COOKIE_NAME] ?? bodyToken;
}
