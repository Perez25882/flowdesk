import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success } from '../../utils/response.js';
import { ListMessagesQuerySchema, UpdateMessageIntentSchema } from './messages.schema.js';
import * as service from './messages.service.js';

export default async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListMessagesQuerySchema.parse(request.query);
    const messages = await service.listMessages(request.business!.id, query);
    return success(reply, messages);
  });

  app.patch('/messages/:id/intent', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = UpdateMessageIntentSchema.parse(request.body);
    const message = await service.updateMessageIntent(
      id,
      request.business!.id,
      data,
      request.user?.staffId ?? 'owner',
    );
    return success(reply, message);
  });
}
