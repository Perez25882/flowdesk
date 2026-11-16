import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { callerHasCapability, requireCapability } from '../../middleware/role.middleware.js';
import { prisma } from '../../config/database.js';
import { NotFoundError } from '../../utils/errors.js';
import { orderActor, requireStaffMembership } from '../orders/orders.authorization.js';
import { success } from '../../utils/response.js';
import {
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  SendReplySchema,
  UpdateMessageIntentSchema,
} from './messages.schema.js';
import * as service from './messages.service.js';
import { getThread, listConversations } from './conversations.js';
import { assignConversation, inboxAssignees, inboxStates, recordInboxRead, requireInboxRead } from './inbox-state.js';
import { SSEManager } from '../../services/sse/sse.manager.js';

const threadParams = z.object({ customerId: z.string().min(1).max(100) });
const revision = z.number().int().nonnegative();

export default async function messageRoutes(app: FastifyInstance): Promise<void> {
  // The inbox: one row per customer rather than one per message. Same
  // capability as reading messages — it is the same data, grouped.
  app.get(
    '/conversations',
    { preHandler: requireCapability('messages.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListConversationsQuerySchema.parse(request.query);
      const actor = orderActor(request);
      await requireInboxRead(actor);
      return success(reply, await listConversations(actor, query));
    },
  );

  app.get(
    '/conversations/:customerId',
    { preHandler: requireCapability('messages.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { customerId } = threadParams.parse(request.params);
      const { before } = z.object({ before: z.string().min(1).max(100).optional() }).strict().parse(request.query);
      const actor = orderActor(request);
      await requireInboxRead(actor);
      const inbox = (await inboxStates(actor, [customerId])).get(customerId);
      return success(reply, { ...(await getThread(actor.businessId, customerId, before)), inbox });
    },
  );

  app.get('/conversations/assignees', { preHandler: requireCapability('staff.manage') }, async (request, reply) =>
    success(reply, await inboxAssignees(orderActor(request))));

  app.put('/conversations/:customerId/assignment', { preHandler: requireCapability('messages.send') }, async (request, reply) => {
    const { customerId } = threadParams.parse(request.params);
    const input = z.object({ staffId: z.string().min(1).max(100).nullable(), revision }).strict().parse(request.body);
    const actor = orderActor(request);
    if (await assignConversation(actor, customerId, input.staffId, input.revision)) {
      SSEManager.getInstance().broadcast(actor.businessId, { type: 'inbox.changed', payload: {} });
    }
    return success(reply, (await inboxStates(actor, [customerId])).get(customerId));
  });

  app.put('/conversations/:customerId/read-state', { preHandler: requireCapability('messages.read') }, async (request, reply) => {
    const { customerId } = threadParams.parse(request.params);
    const input = z.object({ through: z.string().regex(/^\d{1,19}$/).nullable(), revision }).strict().parse(request.body);
    const actor = orderActor(request);
    await recordInboxRead(actor, customerId, input.through === null ? null : BigInt(input.through), input.revision);
    return success(reply, (await inboxStates(actor, [customerId])).get(customerId));
  });

  app.get('/conversations/:customerId/assignment-history', { preHandler: requireCapability('messages.read') }, async (request, reply) => {
    const { customerId } = threadParams.parse(request.params);
    const actor = orderActor(request);
    await requireInboxRead(actor);
    if (!(await inboxStates(actor, [customerId])).has(customerId)) throw new NotFoundError('Conversation not found');
    return success(reply, await prisma.inboxAssignmentEvent.findMany({ where: { businessId: actor.businessId, customerId },
      orderBy: { revision: 'desc' }, take: 50 }));
  });

  app.get('/conversations/:customerId/context', { preHandler: requireCapability('messages.read') }, async (request, reply) => {
    const { customerId } = request.params as { customerId: string };
    const actor = orderActor(request);
    await requireStaffMembership(prisma, actor);
    const scope = { businessId: actor.businessId, customerId };
    if (!await prisma.customer.findFirst({ where: { id: customerId, businessId: scope.businessId, deletedAt: null }, select: { id: true } })) {
      throw new NotFoundError('Conversation not found');
    }
    const [orders, visits, invoices, cases] = await Promise.all([
      callerHasCapability(request, 'orders.read') ? prisma.order.findMany({ where: { ...scope, deletedAt: null },
        orderBy: { createdAt: 'desc' }, take: 4, select: { id: true, referenceNumber: true, status: true } }) : [],
      callerHasCapability(request, 'orders.create') ? prisma.serviceVisit.findMany({
        where: { ...scope, ...(actor.role === 'OPERATIONS' ? { assignedStaffId: actor.staffId } : {}) },
        orderBy: { appointment: { startsAt: 'desc' } }, take: 4, select: { appointmentId: true, state: true,
          appointment: { select: { reference: true } } } }) : [],
      callerHasCapability(request, 'payments.read') ? prisma.commerceInvoice.findMany({ where: scope, orderBy: { issuedAt: 'desc' }, take: 4,
        select: { id: true, reference: true } }) : [],
      prisma.commerceCase.findMany({ where: { ...scope, ...(actor.role === 'OPERATIONS' ? { OR: [
        { assignedStaffId: actor.staffId }, { assignedStaffId: null },
      ] } : {}) }, orderBy: { updatedAt: 'desc' }, take: 4, select: { id: true, kind: true, state: true } }),
    ]);
    return success(reply, { orders, visits, invoices, cases });
  });

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

  app.get(
    '/messages/:id/media',
    { preHandler: requireCapability('messages.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const media = await service.readInboundArchive(request.business!.id, id);
      if (!media) return reply.code(404).send({ success: false, code: 'MEDIA_NOT_FOUND' });
      reply.header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'attachment')
        .type(media.contentType);
      if (media.contentLength !== undefined) reply.header('Content-Length', media.contentLength);
      return reply.send(media.body);
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
      await service.dismissDraft(id, request.business!.id, request.user?.staffId ?? null);
      return success(reply, { dismissed: true });
    },
  );
}
