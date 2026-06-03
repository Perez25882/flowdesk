import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success, created } from '../../utils/response.js';
import { InviteStaffSchema, AcceptInviteSchema, StaffLoginSchema, UpdateStaffSchema } from './staff.schema.js';
import * as service from './staff.service.js';

export default async function staffRoutes(app: FastifyInstance): Promise<void> {
  app.post('/staff/invite', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = InviteStaffSchema.parse(request.body);
    const staff = await service.inviteStaff(data, request.business!.id, request.business!.name);
    return created(reply, staff);
  });

  app.post('/staff/accept', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = AcceptInviteSchema.parse(request.body);
    const staff = await service.acceptInvite(data);
    return success(reply, staff);
  });

  app.post('/staff/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = StaffLoginSchema.parse(request.body);
    const result = await service.loginStaff(data);
    return success(reply, result);
  });

  app.get('/staff', async (request: FastifyRequest, reply: FastifyReply) => {
    const staff = await service.listStaff(request.business!.id);
    return success(reply, staff);
  });

  app.patch('/staff/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = UpdateStaffSchema.parse(request.body);
    const staff = await service.updateStaff(id, request.business!.id, data);
    return success(reply, staff);
  });

  app.get('/staff/:id/activity', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const activity = await service.getStaffActivity(id, request.business!.id);
    return success(reply, activity);
  });
}
