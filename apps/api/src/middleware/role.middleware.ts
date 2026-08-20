import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import {
  hasCapability,
  isAssignmentScoped,
  type Capability,
  type StaffRole,
} from '@flowdesk/shared';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';

/**
 * Role-based access control.
 *
 * The owner is identified by the ABSENCE of a staff id on the token — the
 * Business row is the owner's account. Owners implicitly satisfy every check.
 *
 * Authorization is expressed as capabilities rather than role lists so the
 * matrix lives in one place (`@flowdesk/shared`) and the dashboard renders from
 * the same table the API enforces.
 */

/** True when the token belongs to the business owner rather than a staff member. */
export function isOwner(request: FastifyRequest): boolean {
  return request.user !== undefined && request.user.staffId === undefined;
}

/** The caller's staff role, or undefined for the owner. */
function roleOf(request: FastifyRequest): StaffRole | undefined {
  if (isOwner(request)) return undefined;
  return request.user?.role as StaffRole | undefined;
}

/**
 * Whether the caller holds a capability, as a plain question.
 *
 * `requireCapability` answers the same question but can only ever refuse the
 * whole request, which is the wrong shape for a response that is legitimate for
 * everyone but must carry fewer fields for some. `/orders/stats` is exactly
 * that: every role that can read orders may see the counts, but the revenue
 * totals belong to `revenue.read`, which only a manager or the owner holds.
 *
 * Same rules as `requireCapability`, so the two cannot drift: no token means
 * no, the owner means yes, and a staff token with no resolvable role means no
 * rather than "owner".
 */
export function callerHasCapability(request: FastifyRequest, capability: Capability): boolean {
  if (!request.user) {
    return false;
  }

  if (isOwner(request)) {
    return true;
  }

  const role = request.user.role as StaffRole | undefined;

  // A staff token with no role cannot be resolved against the matrix. Treating
  // it as an owner would be a privilege-escalation bug, so it is refused.
  return role !== undefined && hasCapability(role, capability);
}

/**
 * Restricts a route to callers holding a capability.
 *
 * @example requireCapability('payments.void')
 */
export function requireCapability(capability: Capability) {
  return function capabilityMiddleware(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    if (!request.user) {
      return done(new UnauthorizedError('Authentication required'));
    }

    if (!callerHasCapability(request, capability)) {
      return done(new ForbiddenError('You do not have permission to perform this action'));
    }

    done();
  };
}

/**
 * Restricts a route to the owner alone — used for billing and plan management.
 */
export function requireOwner(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  if (!request.user) {
    return done(new UnauthorizedError('Authentication required'));
  }

  if (!isOwner(request)) {
    return done(new ForbiddenError('Only the business owner can perform this action'));
  }

  done();
}

/**
 * Orders a request is allowed to see.
 *
 * Delivery staff are scoped to their own assignments; everyone else sees the
 * whole business. Returning the staff id (rather than a boolean) lets callers
 * pass it straight into a repository filter.
 *
 * This must be applied by every order read and transition — a capability check
 * alone would let a rider act on another rider's deliveries.
 */
export function assignedStaffScope(request: FastifyRequest): string | undefined {
  if (isAssignmentScoped(roleOf(request)) && request.user?.staffId) {
    return request.user.staffId;
  }
  return undefined;
}
