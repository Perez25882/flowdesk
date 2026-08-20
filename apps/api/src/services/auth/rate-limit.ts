import type { FastifyRequest } from 'fastify';
import { readAccessTokenClaims } from './tokens.js';

/**
 * Rate-limit bucketing for authenticated traffic.
 *
 * The limiter used to read `request.user`, which is set by `requireAuth` — a
 * `preHandler`. `@fastify/rate-limit` installs its hook at `onRequest` (see
 * `defaultHook` in the plugin), which runs first, so `request.user` was ALWAYS
 * undefined at key-generation time. The real behaviour was a flat 100 req/min
 * keyed on `request.ip`; and because TRUST_PROXY defaults to false, behind a
 * load balancer every tenant shared the load balancer's address as their key,
 * so one busy shop could deny service to the whole platform.
 *
 * Deriving the principal from the bearer token here is what makes the intended
 * behaviour real. It is a signature check on a short string — the same one
 * `requireAuth` performs a moment later, and memoised on the request so it is
 * paid for once.
 *
 * The signature must be verified rather than merely decoded: an unverified
 * decode would let anyone claim any business id and either borrow another
 * tenant's budget or hop buckets at will.
 */

/** Requests per window for an authenticated business. */
export const AUTHENTICATED_RATE_LIMIT = 1000;

/** Requests per window for anonymous traffic, keyed on IP. */
export const ANONYMOUS_RATE_LIMIT = 100;

/**
 * The bucket a request counts against.
 *
 * Namespaced by kind so a business id can never collide with an address, and so
 * a key is readable when it turns up in Redis during an incident.
 */
export function rateLimitKeyGenerator(request: FastifyRequest): string {
  const claims = readAccessTokenClaims(request);
  return claims ? `biz:${claims.businessId}` : `ip:${request.ip}`;
}

/** The ceiling for that bucket. Must agree with `rateLimitKeyGenerator`. */
export function rateLimitMax(request: FastifyRequest): number {
  return readAccessTokenClaims(request) ? AUTHENTICATED_RATE_LIMIT : ANONYMOUS_RATE_LIMIT;
}
