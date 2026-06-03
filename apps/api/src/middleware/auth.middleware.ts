import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../utils/errors.js';
import type { BusinessPlan, StaffRole } from '@prisma/client';

interface JWTPayload {
  businessId: string;
  plan: BusinessPlan;
  staffId?: string;
  role?: StaffRole;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim();
}

export function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const token = extractBearerToken(request.headers.authorization);

  if (!token) {
    return done(new UnauthorizedError('Authentication required'));
  }

  let payload: JWTPayload;

  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch {
    return done(new UnauthorizedError('Invalid or expired token'));
  }

  const userData: FastifyRequest['user'] = {
    businessId: payload.businessId,
    plan: payload.plan,
  };
  if (payload.staffId !== undefined) userData.staffId = payload.staffId;
  if (payload.role !== undefined) userData.role = payload.role;
  request.user = userData;

  done();
}

export function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const token = extractBearerToken(request.headers.authorization);

  if (!token) {
    return done();
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    const userData: FastifyRequest['user'] = {
      businessId: payload.businessId,
      plan: payload.plan,
    };
    if (payload.staffId !== undefined) userData.staffId = payload.staffId;
    if (payload.role !== undefined) userData.role = payload.role;
    request.user = userData;
  } catch {
    // Invalid token in optional auth is silently ignored
  }

  done();
}
