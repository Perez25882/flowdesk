import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { persistOutboundSend } from '../../queues/outbound.queue.js';
import { requireCapability, requireOwner } from '../../middleware/role.middleware.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { success, created } from '../../utils/response.js';
import { orderActor, requireStaffMembership } from '../orders/orders.authorization.js';
import { createPaymentLink } from '../payments/payment-links.service.js';
import { requirePaymentActor } from '../payments/payment-relationships.js';
import { caseInput, invoiceCheckoutInput, policyInput, preparationInput, quoteDecisionInput, quoteInput } from './commerce.contract.js';
import { activeCommercePolicy, createCommerceQuote, decideCommerceQuote } from './commerce.quotes.js';
import { invoiceView } from './commerce.invoices.js';
import { updatePreparation } from './commerce.fulfillment.js';
import { updateCommerceCase } from './commerce.cases.js';

const idParams = z.object({ id: z.string().min(1).max(100) });

export default async function commerceRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner };
  const sales = { preHandler: requireCapability('orders.create') };
  const payments = { preHandler: requireCapability('payments.read') };
  const checkout = { preHandler: requireCapability('payments.create') };
  const support = { preHandler: requireCapability('messages.read') };
  const resolve = { preHandler: requireCapability('messages.send') };

  app.get('/commerce/policy', owner, async (request, reply) =>
    success(reply, await prisma.commercePolicy.findUnique({ where: { businessId: request.business!.id } })));

  app.put('/commerce/policy', owner, async (request, reply) => {
    const { revision, ...settings } = policyInput.parse(request.body);
    const businessId = request.business!.id;
    const result = await prisma.$transaction(async (tx) => {
      if (settings.enabled && !await tx.workflowSettings.findFirst({
        where: { businessId, enabled: true, profile: { in: ['ONLINE_RETAIL', 'CUSTOM_ORDER'] } }, select: { businessId: true },
      })) throw new ConflictError('Enable a commerce workflow profile first');
      const change = revision === 0
        ? await tx.commercePolicy.createMany({ data: { businessId, ...settings }, skipDuplicates: true })
        : await tx.commercePolicy.updateMany({ where: { businessId, revision }, data: { ...settings, revision: { increment: 1 } } });
      if (!change.count) throw new ConflictError('Commerce policy changed');
      return tx.commercePolicy.findUniqueOrThrow({ where: { businessId } });
    });
    return success(reply, result);
  });

  app.get('/commerce/quotes', sales, async (request, reply) => {
    const actor = orderActor(request);
    await requirePaymentActor(prisma, actor.businessId, actor.staffId, 'orders.create');
    const quotes = await prisma.commerceQuote.findMany({ where: { businessId: actor.businessId },
      include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 50 });
    return success(reply, quotes);
  });

  app.post('/commerce/quotes', sales, async (request, reply) => {
    const input = quoteInput.parse(request.body);
    const actor = orderActor(request);
    const quote = await prisma.$transaction(async (tx) => {
      await requirePaymentActor(tx, actor.businessId, actor.staffId, 'orders.create');
      return createCommerceQuote(tx, actor.businessId, input);
    });
    return created(reply, quote);
  });

  app.post('/commerce/quotes/:id/decision', owner, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { decision } = quoteDecisionInput.parse(request.body);
    return success(reply, await prisma.$transaction((tx) => decideCommerceQuote(tx, request.business!.id, id, decision === 'OFFER')));
  });

  app.get('/commerce/invoices', payments, async (request, reply) => {
    const actor = orderActor(request);
    const { orderId } = z.object({ orderId: z.string().min(1).max(100).optional() }).strict().parse(request.query);
    await requirePaymentActor(prisma, actor.businessId, actor.staffId, 'payments.read');
    const rows = await prisma.commerceInvoice.findMany({ where: { businessId: actor.businessId, ...(orderId ? { orderId } : {}) },
      orderBy: { issuedAt: 'desc' }, take: 50, select: { id: true, orderId: true, reference: true, total: true, issuedAt: true, dueAt: true } });
    return success(reply, rows);
  });

  app.get('/commerce/invoices/:id', payments, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = orderActor(request);
    await requirePaymentActor(prisma, actor.businessId, actor.staffId, 'payments.read');
    return success(reply, await invoiceView(prisma, id, actor.businessId));
  });

  app.post('/commerce/invoices/:id/checkout', checkout, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { send } = invoiceCheckoutInput.parse(request.body);
    const actor = orderActor(request);
    await requirePaymentActor(prisma, actor.businessId, actor.staffId, 'payments.create');
    const invoice = await invoiceView(prisma, id, actor.businessId);
    if (invoice.state === 'CANCELLED' || !invoice.nextCharge.gt(0)) throw new ConflictError('Invoice has no amount payable');
    const result = await createPaymentLink(actor.businessId, {
      customerId: invoice.customerId, orderId: invoice.orderId, amount: Number(invoice.nextCharge), send,
    }, actor.staffId);
    return success(reply, result);
  });

  app.patch('/commerce/orders/:id/preparation', sales, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = preparationInput.parse(request.body);
    return success(reply, await prisma.$transaction((tx) => updatePreparation(tx, orderActor(request), id, input.state, input.assignedStaffId)));
  });

  app.get('/commerce/cases', support, async (request, reply) => {
    const actor = orderActor(request);
    await requirePaymentActor(prisma, actor.businessId, actor.staffId, 'messages.read');
    await requireStaffMembership(prisma, actor);
    return success(reply, await prisma.commerceCase.findMany({
      where: { businessId: actor.businessId, ...(actor.role === 'OPERATIONS' ? { OR: [
        { assignedStaffId: actor.staffId }, { assignedStaffId: null },
      ] } : {}) },
      include: { customer: { select: { name: true } }, order: { select: { referenceNumber: true, status: true } } },
      orderBy: { createdAt: 'desc' }, take: 50,
    }));
  });

  app.get('/commerce/cases/:id', support, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = orderActor(request);
    await requirePaymentActor(prisma, actor.businessId, actor.staffId, 'messages.read');
    await requireStaffMembership(prisma, actor);
    const item = await prisma.commerceCase.findFirst({ where: { id, businessId: actor.businessId,
      ...(actor.role === 'OPERATIONS' ? { OR: [{ assignedStaffId: actor.staffId }, { assignedStaffId: null }] } : {}) },
    include: { history: { orderBy: { revision: 'asc' } } } });
    if (!item) throw new NotFoundError('Case not found');
    const evidence = await prisma.message.findFirst({ where: { businessId: actor.businessId, customerId: item.customerId,
      body: { equals: 'RESOLVED ' + item.id, mode: 'insensitive' }, direction: 'INBOUND',
      createdAt: { gte: new Date(+item.createdAt - 1000) }, textReceipt: { status: 'COMPLETED', businessId: actor.businessId, kind: 'TEXT' } },
      select: { id: true }, orderBy: { createdAt: 'desc' } });
    return success(reply, { ...item, customerConfirmationId: evidence?.id ?? null });
  });

  app.patch('/commerce/cases/:id', resolve, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = caseInput.parse(request.body);
    return success(reply, await prisma.$transaction((tx) => updateCommerceCase(tx, orderActor(request), id, input)));
  });

  app.post('/commerce/orders/:id/followup', owner, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const businessId = request.business!.id;
    const sendId = await prisma.$transaction(async (tx) => {
      const policy = await activeCommercePolicy(tx, businessId);
      if (!policy.allowFollowup) throw new ConflictError('Order follow-ups are disabled');
      const order = await tx.order.findFirst({ where: { id, businessId, deletedAt: null, status: 'FULFILLED',
        commerceInvoice: { isNot: null }, customer: { businessId, blacklisted: false, deletedAt: null, waNumberInvalid: false,
          commerceFollowup: true, commerceConsentId: { not: null }, lastInboundAt: { gt: new Date(Date.now() - 86_400_000) } } },
      select: { customerId: true, referenceNumber: true, customer: { select: { waNumber: true, commerceConsentId: true } } } });
      if (!order) throw new NotFoundError('No eligible order with current customer permission');
      const key = 'commerce-followup-' + id;
      return await persistOutboundSend(tx, { businessId, customerId: order.customerId, to: order.customer.waNumber,
        relatedOrderId: id, commerceFollowupConsentId: order.customer.commerceConsentId!,
        body: 'Is everything right with order ' + order.referenceNumber + '? Reply if the shop should help. Reply STOP ORDER FOLLOWUPS to stop these follow-ups.',
      }, key) ?? (await tx.whatsAppSend.findUniqueOrThrow({ where: { businessId_eventKey: { businessId, eventKey: key } } })).id;
    });
    return success(reply, { sendId });
  });
}
