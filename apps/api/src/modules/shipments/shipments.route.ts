import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { orderActor, requireOrderRouteAccess } from '../orders/orders.authorization.js';
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
 * Reads and writes use the existing order capabilities and the order's scope.
 */
export default async function shipmentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/orders/:id/shipment',
    { preHandler: requireOrderRouteAccess('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const shipment = await getShipmentForOrder(
        (request.params as { id: string }).id,
        orderActor(request),
      );
      return success(reply, { shipment });
    },
  );

  app.post(
    '/orders/:id/dispatch',
    { preHandler: requireOrderRouteAccess('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = DispatchOrderSchema.parse(request.body ?? {});
      const shipment = await dispatchOrder(
        (request.params as { id: string }).id,
        orderActor(request),
        body,
      );
      return success(reply, { shipment });
    },
  );

  app.post(
    '/orders/:id/dispatch/proof',
    { preHandler: requireOrderRouteAccess('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { image } = ProofOfDispatchSchema.parse(request.body);
      const shipment = await attachProofOfDispatch(
        (request.params as { id: string }).id,
        orderActor(request),
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
    { preHandler: requireOrderRouteAccess('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ref = await getProofKey(
        (request.params as { id: string }).id,
        orderActor(request),
      );
      if (!ref) throw new NotFoundError('No proof of dispatch for this order');

      const object = await getArchivedMedia(ref.key);
      if (!object) throw new NotFoundError('No proof of dispatch for this order');

      // Streamed rather than buffered: a 5 MB photo held in memory per request
      // is 5 MB the API does not have to hold.
      return reply
        .header('Content-Type', object.contentType || ref.mimeType)
        .header('Cache-Control', 'private, no-store')
        .send(object.body);
    },
  );

  app.post(
    '/orders/:id/dispatch/delivered',
    { preHandler: requireOrderRouteAccess('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const shipment = await markShipmentDelivered(
        (request.params as { id: string }).id,
        orderActor(request),
      );
      return success(reply, { shipment });
    },
  );
}
