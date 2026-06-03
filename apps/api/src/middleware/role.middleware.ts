import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import type { StaffRole } from '@prisma/client';

export function requireRole(allowedRoles: StaffRole[]) {
  return function roleMiddleware(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    if (!request.user) {
      return done(new UnauthorizedError('Authentication required'));
    }

    if (!request.user.role) {
      return done(new ForbiddenError('Owner access required'));
    }

    if (!allowedRoles.includes(request.user.role)) {
      return done(new ForbiddenError('Insufficient permissions'));
    }

    done();
  };
}
