import type { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '../utils/errors.js';
import { businessSubject, isTokenRevoked, staffSubject } from '../services/auth/revocation.js';
import { readAccessTokenClaims } from '../services/auth/tokens.js';

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Signature, algorithm, token type, issuer and audience are all asserted in
  // `verifyAccessToken`. Asserting the TYPE is what stops a refresh token being
  // presented as a bearer token: a refresh payload carries no staff id, and
  // `role.middleware.ts` reads an absent staff id as "this is the owner".
  //
  // The claims are memoised per request, so the rate limiter having already
  // read them at `onRequest` means this costs nothing.
  const payload = readAccessTokenClaims(request);

  if (!payload) {
    throw new UnauthorizedError(
      request.headers.authorization ? 'Invalid or expired token' : 'Authentication required',
    );
  }

  // A stateless JWT stays valid until it expires, so a password reset,
  // "log out everywhere", or staff deactivation would otherwise leave an
  // already-issued access token working for up to 15 more minutes. Reject any
  // token issued before the subject's revocation epoch. Staff are keyed by
  // staff id (per-person), owners by business id.
  const subject = payload.staffId ? staffSubject(payload.staffId) : businessSubject(payload.businessId);
  if (await isTokenRevoked(subject, payload.iat)) {
    throw new UnauthorizedError('Session has been revoked. Please sign in again.');
  }

  const userData: FastifyRequest['user'] = {
    businessId: payload.businessId,
    plan: payload.plan,
  };
  if (payload.staffId !== undefined) userData.staffId = payload.staffId;
  if (payload.role !== undefined) userData.role = payload.role;
  request.user = userData;
}
