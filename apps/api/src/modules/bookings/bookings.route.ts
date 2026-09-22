import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { success, created } from '../../utils/response.js';
import { requireCapability } from '../../middleware/role.middleware.js';
import * as service from './bookings.service.js';
import {
  CreateAppointmentSchema,
  CreateServiceSchema,
  ListAppointmentsQuerySchema,
  SlotQuerySchema,
  UpdateAppointmentSchema,
  UpdateServiceSchema,
} from './bookings.schema.js';

/**
 * The diary.
 *
 * Services sit behind the `products.*` capabilities rather than a set of their
 * own: a service is what this kind of business sells, and a staff member
 * trusted to edit the catalogue is the same person trusted to say how long a
 * consultation takes. Appointments sit behind `orders.*` for the same reason —
 * for a clinic, the appointment IS the order.
 */
export default async function bookingRoutes(app: FastifyInstance): Promise<void> {
  const canReadCatalogue = { preHandler: requireCapability('products.read') };
  const canWriteCatalogue = { preHandler: requireCapability('products.write') };
  const canReadOrders = { preHandler: requireCapability('orders.read') };
  // `orders.create` rather than a booking-specific capability: taking an
  // appointment is creating the thing this kind of business sells, and anyone
  // trusted to raise an order is trusted to write one into the diary.
  const canWriteOrders = { preHandler: requireCapability('orders.create') };
  const canTransitionOrders = { preHandler: requireCapability('orders.transition') };

  app.get('/services', canReadCatalogue, async (request: FastifyRequest, reply: FastifyReply) => {
    return success(reply, await service.listServices(request.business!.id));
  });

  app.post('/services', canWriteCatalogue, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = CreateServiceSchema.parse(request.body);

    const row = await prisma.service.create({
      data: {
        businessId: request.business!.id,
        name: data.name,
        description: data.description ?? null,
        aliases: data.aliases,
        durationMinutes: data.durationMinutes,
        bufferMinutes: data.bufferMinutes,
        capacity: data.capacity,
        price:
          data.price === null || data.price === undefined
            ? null
            : new Prisma.Decimal(data.price),
      },
    });

    return created(reply, row);
  });

  app.patch(
    '/services/:id',
    canWriteCatalogue,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const data = UpdateServiceSchema.parse(request.body);

      const patch: Prisma.ServiceUpdateInput = {};
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description;
      if (data.aliases !== undefined) patch.aliases = data.aliases;
      if (data.durationMinutes !== undefined) patch.durationMinutes = data.durationMinutes;
      if (data.bufferMinutes !== undefined) patch.bufferMinutes = data.bufferMinutes;
      if (data.capacity !== undefined) patch.capacity = data.capacity;
      if (data.active !== undefined) patch.active = data.active;
      if (data.price !== undefined) {
        patch.price = data.price === null ? null : new Prisma.Decimal(data.price);
      }

      // Scoped by businessId inside the WHERE rather than checked afterwards:
      // a staff member holding another tenant's service id must get a 404, not
      // an edit.
      const result = await prisma.service.updateMany({
        where: { id, businessId: request.business!.id, deletedAt: null },
        data: patch,
      });

      if (result.count === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }

      return success(reply, await prisma.service.findUnique({ where: { id } }));
    },
  );

  app.delete(
    '/services/:id',
    canWriteCatalogue,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Soft delete. Appointments hold a foreign key to this row, and a diary
      // that has lost the name of what was booked is worse than one carrying a
      // service nobody offers any more.
      const result = await prisma.service.updateMany({
        where: { id, businessId: request.business!.id, deletedAt: null },
        data: { deletedAt: new Date(), active: false },
      });

      if (result.count === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }

      return success(reply, { id });
    },
  );

  /** What is free. The only honest source of a time to offer a customer. */
  app.get(
    '/services/:id/slots',
    canReadCatalogue,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const query = SlotQuerySchema.parse(request.query);

      const result = await service.findSlots(request.business!.id, {
        serviceId: id,
        ...(query.from ? { from: query.from } : {}),
        days: query.days,
        limit: query.limit,
      });

      return success(reply, result);
    },
  );

  app.get('/appointments', canReadOrders, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListAppointmentsQuerySchema.parse(request.query);

    return success(
      reply,
      await service.listAppointments(request.business!.id, {
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(query.status ? { status: query.status } : {}),
      }),
    );
  });

  app.post(
    '/appointments',
    canWriteOrders,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = CreateAppointmentSchema.parse(request.body);

      const appointment = await service.book({
        businessId: request.business!.id,
        serviceId: data.serviceId,
        customerId: data.customerId,
        startsAt: data.startsAt,
        notes: data.notes ?? null,
      });

      return created(reply, appointment);
    },
  );

  app.patch(
    '/appointments/:id',
    canTransitionOrders,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const data = UpdateAppointmentSchema.parse(request.body);

      if (data.status === 'CANCELLED') {
        await service.cancelAppointment(id, request.business!.id, data.cancelReason ?? null);
      } else if (data.status) {
        await service.setStatus(id, request.business!.id, data.status);
      }

      return success(reply, { id });
    },
  );
}
