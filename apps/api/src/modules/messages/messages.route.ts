import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireCapability } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import {
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  SendReplySchema,
  UpdateMessageIntentSchema,
} from './messages.schema.js';
import * as service from './messages.service.js';
import { getThread, listConversations } from './conversations.js';

export default async function messageRoutes(app: FastifyInstance): Promise<void> {
  // The inbox: one row per customer rather than one per message. Same
  // capability as reading messages — it is the same data, grouped.
  app.get(
    '/conversations',
    { preHandler: requireCapability('messages.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListConversationsQuerySchema.parse(request.query);
      return success(reply, await listConversations(request.business!.id, query));
    },
  );

  app.get(
    '/conversations/:customerId',
    { preHandler: requireCapability('messages.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { customerId } = request.params as { customerId: string };
      return success(reply, await getThread(request.business!.id, customerId));
    },
  );

  app.get(
    '/messages',
    { preHandler: requireCapability('messages.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListMessagesQuerySchema.parse(request.query);
      const messages = await service.listMessages(request.business!.id, query);
      return success(reply, messages);
    },
  );

  app.patch(
    '/messages/:id/intent',
    { preHandler: requireCapability('messages.write') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const data = UpdateMessageIntentSchema.parse(request.body);
      const message = await service.updateMessageIntent(
        id,
        request.business!.id,
        data,
        request.user?.staffId ?? 'owner',
      );
      return success(reply, message);
    },
  );

  /**
   * Reply to a customer.
   *
   * Gated on `messages.send` rather than `messages.write` — the latter only ever
   * meant "relabel an intent", and reusing it would hand everyone who can
   * correct a label the ability to speak to customers as the business.
   */
  app.post(
    '/messages/:id/reply',
    { preHandler: requireCapability('messages.send') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const data = SendReplySchema.parse(request.body);

      const result = await service.sendReply(
        id,
        request.business!.id,
        data,
        request.user?.staffId ?? null,
      );

      return success(reply, result);
    },
  );

  /** Throws away a suggested reply the owner does not want to send. */
  app.post(
    '/messages/:id/dismiss-draft',
    { preHandler: requireCapability('messages.send') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      await service.dismissDraft(id, request.business!.id);
      return success(reply, { dismissed: true });
    },
  );
}
