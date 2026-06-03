import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success } from '../../utils/response.js';
import { prisma } from '../../config/database.js';

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const business = await prisma.business.findUnique({
      where: { id: request.business!.id },
      select: {
        id: true,
        name: true,
        phone: true,
        ownerName: true,
        plan: true,
        trialEndsAt: true,
        waWebhookVerified: true,
        monthlyConvoCount: true,
        notifyOnNewOrder: true,
        notifyOnLowStock: true,
        notifyOnPayment: true,
        replyTemplates: true,
        createdAt: true,
      },
    });
    return success(reply, business);
  });

  app.patch('/businesses/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.ownerName !== undefined) data.ownerName = body.ownerName;
    if (body.notifyOnNewOrder !== undefined) data.notifyOnNewOrder = body.notifyOnNewOrder;
    if (body.notifyOnLowStock !== undefined) data.notifyOnLowStock = body.notifyOnLowStock;
    if (body.notifyOnPayment !== undefined) data.notifyOnPayment = body.notifyOnPayment;
    if (body.replyTemplates !== undefined) data.replyTemplates = body.replyTemplates;

    const business = await prisma.business.update({
      where: { id: request.business!.id },
      data,
      select: {
        id: true,
        name: true,
        phone: true,
        ownerName: true,
        plan: true,
        trialEndsAt: true,
        waWebhookVerified: true,
        notifyOnNewOrder: true,
        notifyOnLowStock: true,
        notifyOnPayment: true,
        replyTemplates: true,
      },
    });
    return success(reply, business);
  });
}
