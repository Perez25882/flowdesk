import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success } from '../../utils/response.js';
import { prisma } from '../../config/database.js';
import { UpdateBusinessSchema } from './settings.schema.js';

const BUSINESS_SELECT = {
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
} as const;

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const business = await prisma.business.findUnique({
      where: { id: request.business!.id },
      select: BUSINESS_SELECT,
    });
    return success(reply, business);
  });

  app.patch('/businesses/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = UpdateBusinessSchema.parse(request.body);
    // exactOptionalPropertyTypes: strip undefined keys so optional fields
    // don't fail Prisma's BusinessUpdateInput type check.
    const data = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const business = await prisma.business.update({
      where: { id: request.business!.id },
      data,
      select: BUSINESS_SELECT,
    });
    return success(reply, business);
  });
}
