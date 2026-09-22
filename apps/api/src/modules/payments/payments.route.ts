import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireCapability, requireOwner } from '../../middleware/role.middleware.js';
import { created, success } from '../../utils/response.js';
import {
  ConfirmPaymentSchema,
  ConnectPayoutSchema,
  CreatePaymentLinkSchema,
  CreatePaymentSchema,
  ListPaymentLinksQuerySchema,
  ListPaymentsQuerySchema,
  ReviewQueueQuerySchema,
  VoidPaymentSchema,
} from './payments.schema.js';
import type { ListPaymentsQueryInput } from './payments.schema.js';
import * as service from './payments.service.js';
import * as links from './payment-links.service.js';
import * as payouts from './payouts.service.js';

/**
 * Payment routes.
 *
 * Recording money and attesting to it are separate capabilities on purpose:
 * counter staff log what they take, and only a manager or the owner attests that
 * it landed or voids a record. Without that split any staff account could both
 * fabricate attested money and later erase the evidence of it.
 *
 * There is no delete. A payment is voided, with a reason, and the row survives —
 * which is also how a screenshot the detector got wrong is dismissed.
 */
export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  // ── Payment links ─────────────────────────────────────────────────────────
  //
  // Registered before `/payments/:id` so `/payments/links` is not swallowed by
  // the id route and read as a payment called "links".

  app.get(
    '/payments/links',
    { preHandler: requireCapability('payments.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListPaymentLinksQuerySchema.parse(request.query);
      return success(reply, await links.listPaymentLinks(request.business!.id, query));
    },
  );

  // Raising a request for money is `payments.create`, the same capability as
  // recording one. Attesting stays separate: a link nobody paid still cannot
  // become attested money without the gateway saying so.
  app.post(
    '/payments/links',
    { preHandler: requireCapability('payments.create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = CreatePaymentLinkSchema.parse(request.body);
      const link = await links.createPaymentLink(
        request.business!.id,
        data,
        request.user?.staffId ?? null,
      );
      return created(reply, link);
    },
  );

  app.delete(
    '/payments/links/:id',
    { preHandler: requireCapability('payments.create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      await links.cancelPaymentLink(id, request.business!.id);
      return reply.status(204).send();
    },
  );

  // ── Payouts ───────────────────────────────────────────────────────────────
  //
  // Where the shop's money goes belongs to the account holder alone, alongside
  // paying for the product and revoking everyone's sessions. These are
  // `requireOwner` rather than a capability because no staff capability is
  // strict enough: `settings.write` is held by MANAGER, so gating on it let a
  // single phished day-to-day staff login repoint the shop's entire takings.
  //
  // `PUT` rewrites the live Paystack subaccount's settlement bank and account
  // number IN PLACE, so it redirects money already in flight, not merely future
  // sales. `GET` is owner-only for a quieter reason: it reads back the account
  // number and the resolved account-holder name.
  //
  // The list of networks and banks carries nothing about this shop, so it stays
  // readable by anyone who can see settings — the payout form needs it to
  // render before the owner has connected anything.

  app.get(
    '/payouts/destinations',
    { preHandler: requireCapability('settings.read') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return success(reply, await payouts.listDestinations());
    },
  );

  app.get(
    '/payouts',
    { preHandler: requireOwner },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return success(reply, await payouts.getPayoutStatus(request.business!.id));
    },
  );

  app.put(
    '/payouts',
    { preHandler: requireOwner },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = ConnectPayoutSchema.parse(request.body);
      return success(reply, await payouts.connectPayout(request.business!.id, data));
    },
  );

  app.post(
    '/payments',
    { preHandler: requireCapability('payments.create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = CreatePaymentSchema.parse(request.body);

      // `attested` is not the caller's to assert unless they could attest a
      // payment outright. Staff without that capability record a claim for
      // review instead, whatever the request body said.
      const canAttest = request.user?.staffId === undefined || request.user?.role === 'MANAGER';

      const payment = await service.logPayment(
        { ...data, attested: canAttest ? data.attested : false },
        request.business!.id,
        request.user?.staffId ?? null,
      );
      return created(reply, payment);
    },
  );

  app.get(
    '/payments',
    { preHandler: requireCapability('payments.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListPaymentsQuerySchema.parse(request.query) as ListPaymentsQueryInput;
      const payments = await service.listPayments(request.business!.id, query);
      return success(reply, payments);
    },
  );

  // Registered before the `:id` routes so the literal path is never read as an
  // id. Fastify's router prefers static segments anyway; the order is for the
  // next person reading the file.
  app.get(
    '/payments/review-queue',
    { preHandler: requireCapability('payments.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ReviewQueueQuerySchema.parse(request.query);
      const queue = await service.getReviewQueue(request.business!.id, query);
      return success(reply, queue);
    },
  );

  app.patch(
    '/payments/:id/confirm',
    { preHandler: requireCapability('payments.verify') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const data = ConfirmPaymentSchema.parse(request.body);
      const payment = await service.confirmPayment(
        id,
        request.business!.id,
        data,
        request.user?.staffId ?? 'owner',
      );
      return success(reply, payment);
    },
  );

  app.get(
    '/payments/:id/screenshot',
    { preHandler: requireCapability('payments.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const media = await service.readPaymentScreenshot(id, request.business!.id);

      // Private: this is a customer's payment record, and it must not be held
      // by any cache between here and the one dashboard that asked for it.
      return reply
        .header('Content-Type', media.contentType)
        .header('Cache-Control', 'private, max-age=300')
        .send(media.body);
    },
  );

  app.patch(
    '/payments/:id/attest',
    { preHandler: requireCapability('payments.verify') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const payment = await service.attestPayment(
        id,
        request.business!.id,
        request.user?.staffId ?? 'owner',
      );
      return success(reply, payment);
    },
  );

  app.post(
    '/payments/:id/void',
    { preHandler: requireCapability('payments.void') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { reason } = VoidPaymentSchema.parse(request.body);
      await service.voidPayment(
        id,
        request.business!.id,
        request.user?.staffId ?? 'owner',
        reason,
      );
      return reply.status(204).send();
    },
  );

  app.get(
    '/payments/stats',
    { preHandler: requireCapability('revenue.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await service.getPaymentStats(request.business!.id);
      return success(reply, stats);
    },
  );
}
