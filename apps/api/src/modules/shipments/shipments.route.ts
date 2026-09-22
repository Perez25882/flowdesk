import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireCapability } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import { NotFoundError } from '../../utils/errors.js';
import { getArchivedMedia } from '../../services/s3/media.js';
import {
  attachProofOfDispatch,
  dispatchOrder,
  getProofKey,
  getShipmentForOrder,
  markShipmentDelivered,
} from './shipments.service.js';
import { DispatchOrderSchema, ProofOfDispatchSchema } from './shipments.schema.js';

/**
 * Dispatch lives under the order it belongs to, because a shipment has no
 * meaning without one and nobody is ever looking for a shipment id.
 *
 * Everything here is gated on `orders.transition` rather than a new capability.
 * The DELIVERY role already holds it, which is the whole point: the person
 * putting the order on a bike is the person recording that they did.
 */
export default async function shipmentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/orders/:id/shipment',
    { preHandler: requireCapability('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const shipment = await getShipmentForOrder(
        (request.params as { id: string }).id,
        request.business!.id,
      );
      return success(reply, { shipment });
    },
  );

  app.post(
    '/orders/:id/dispatch',
    { preHandler: requireCapability('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = DispatchOrderSchema.parse(request.body ?? {});
      const shipment = await dispatchOrder(
        (request.params as { id: string }).id,
        request.business!.id,
        request.user?.staffId ?? null,
        body,
      );
      return success(reply, { shipment });
    },
  );

  app.post(
    '/orders/:id/dispatch/proof',
    { preHandler: requireCapability('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { image } = ProofOfDispatchSchema.parse(request.body);
      const shipment = await attachProofOfDispatch(
        (request.params as { id: string }).id,
        request.business!.id,
        request.user?.staffId ?? null,
        image,
      );
      return success(reply, { shipment });
    },
  );

  /**
   * Streams the proof back rather than handing out the object key.
   *
   * The bucket is private and the key is an internal path; serving it through
   * an authenticated route means the same capability check that guards the
   * order guards the photograph of it.
   */
  app.get(
    '/orders/:id/dispatch/proof',
    { preHandler: requireCapability('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ref = await getProofKey(
        (request.params as { id: string }).id,
        request.business!.id,
      );
      if (!ref) throw new NotFoundError('No proof of dispatch for this order');

      const object = await getArchivedMedia(ref.key);
      if (!object) throw new NotFoundError('No proof of dispatch for this order');

      // Streamed rather than buffered: a 5 MB photo held in memory per request
      // is 5 MB the API does not have to hold.
      return reply
        .header('Content-Type', object.contentType || ref.mimeType)
        // Immutable: a replacement photo is written to a new key, so this one
        // never changes under a cached copy.
        .header('Cache-Control', 'private, max-age=86400, immutable')
        .send(object.body);
    },
  );

  app.post(
    '/orders/:id/dispatch/delivered',
    { preHandler: requireCapability('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const shipment = await markShipmentDelivered(
        (request.params as { id: string }).id,
        request.business!.id,
        request.user?.staffId ?? null,
      );
      return success(reply, { shipment });
    },
  );
}
