import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success, created } from '../../utils/response.js';
import { requireCapability } from '../../middleware/role.middleware.js';
import {
  InviteStaffSchema,
  AcceptInviteSchema,
  StaffLoginSchema,
  UpdateStaffSchema,
} from './staff.schema.js';
import * as service from './staff.service.js';
import { setRefreshCookie } from '../auth/session-cookie.js';

/**
 * Staff sign-in and invitation acceptance.
 *
 * These MUST be registered outside the authenticated plugin scope: they are how
 * a staff member obtains a token in the first place. They previously sat behind
 * `requireAuth`, which made the entire staff feature unreachable — a token was
 * required in order to get a token.
 */
export async function staffPublicRoutes(app: FastifyInstance): Promise<void> {
  const rateLimit = {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  };

  app.post('/staff/accept', rateLimit, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = AcceptInviteSchema.parse(request.body);
    const staff = await service.acceptInvite(data);
    return success(reply, staff);
  });

  app.post('/staff/login', rateLimit, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = StaffLoginSchema.parse(request.body);
    const result = await service.loginStaff(data);

    // Same session handling as owner sign-in: the refresh token goes into the
    // httpOnly cookie and never reaches client-side JavaScript.
    setRefreshCookie(reply, result.refreshToken);
    const { refreshToken: _omitted, ...safe } = result;

    return success(reply, safe);
  });
}

/** Staff administration. Managing the roster is restricted to owners and managers. */
export default async function staffRoutes(app: FastifyInstance): Promise<void> {
  const managerOnly = { preHandler: requireCapability('staff.manage') };

  app.post('/staff/invite', managerOnly, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = InviteStaffSchema.parse(request.body);
    const staff = await service.inviteStaff(data, request.business!.id, request.business!.name);
    return created(reply, staff);
  });

  // Reading the roster exposes co-workers' names and phone numbers, so it is
  // gated too — just at a lower bar than changing it.
  app.get(
    '/staff',
    { preHandler: requireCapability('staff.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const staff = await service.listStaff(request.business!.id);
      return success(reply, staff);
    },
  );

  app.patch('/staff/:id', managerOnly, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = UpdateStaffSchema.parse(request.body);
    const staff = await service.updateStaff(id, request.business!.id, data);
    return success(reply, staff);
  });

  app.get(
    '/staff/:id/activity',
    managerOnly,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const activity = await service.getStaffActivity(id, request.business!.id);
      return success(reply, activity);
    },
  );
}
