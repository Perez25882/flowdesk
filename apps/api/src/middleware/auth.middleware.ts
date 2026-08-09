import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../utils/errors.js';
import { businessSubject, isTokenRevoked, staffSubject } from '../services/auth/revocation.js';
import type { BusinessPlan, StaffRole } from '@prisma/client';

interface JWTPayload {
  businessId: string;
  plan: BusinessPlan;
  staffId?: string;
  role?: StaffRole;
  /** Issued-at, epoch seconds. Set by jwt.sign; compared against the revocation epoch. */
  iat?: number;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim();
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);

  if (!token) {
    throw new UnauthorizedError('Authentication required');
  }

  let payload: JWTPayload;

  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
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

