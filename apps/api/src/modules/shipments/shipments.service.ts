import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { features } from '../../config/env.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { describeRejection, inspectImageUpload } from '../../services/media/image-file.js';
import { deleteObject, uploadBufferToS3 } from '../../services/s3/media.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { dispatchOrderStatus, fulfillOrder } from '../orders/orders.service.js';
import type { DispatchOrderInput } from './shipments.schema.js';

/**
 * What left the shop, when, with whom, and the photo that proves it.
 *
 * Before this, FULFILLED was a bare status flip: the order said "done" and
 * nothing recorded who sent it, on what, or whether it had actually gone
 * anywhere. That is fine until a customer says they never received it, at which
 * point the shop has an argument rather than a record.
 */

export interface ShipmentView {
  orderId: string;
  courier: string | null;
  trackingNumber: string | null;
  notes: string | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  hasProof: boolean;
  proofUploadedAt: Date | null;
}

const SHIPMENT_SELECT = {
  orderId: true,
  courier: true,
  trackingNumber: true,
  notes: true,
  dispatchedAt: true,
  deliveredAt: true,
  proofKey: true,
  proofUploadedAt: true,
} as const;

function toView(row: {
  orderId: string;
  courier: string | null;
  trackingNumber: string | null;
  notes: string | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  proofKey: string | null;
  proofUploadedAt: Date | null;
}): ShipmentView {
  const { proofKey, ...rest } = row;
  // The key never leaves the API. It is an object path in a private bucket, and
  // handing it to the browser invites someone to try their luck against the
  // bucket directly. The proof is served by its own endpoint instead.
  return { ...rest, hasProof: proofKey !== null };
}

async function requireOrder(orderId: string, businessId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, businessId, deletedAt: null },
    select: { id: true, status: true, referenceNumber: true, deliveryAddress: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  return order;
}

export async function getShipmentForOrder(
  orderId: string,
  businessId: string,
): Promise<ShipmentView | null> {
  const row = await prisma.shipment.findFirst({
    where: { orderId, businessId },
    select: SHIPMENT_SELECT,
  });
  return row ? toView(row) : null;
}

/**
 * Records the dispatch and moves the order to DISPATCHED.
 *
 * The shipment row is written BEFORE the status transition, and the order
 * matters: `notifyOrderStatus` reads the shipment to build the customer's
 * message, so transitioning first would send "your order is on its way" with
 * the courier and tracking silently missing from it.
 */
export async function dispatchOrder(
  orderId: string,
  businessId: string,
  actorId: string | null,
  input: DispatchOrderInput,
): Promise<ShipmentView> {
  const order = await requireOrder(orderId, businessId);

  if (order.status === 'DISPATCHED') {
    throw new ValidationError(`${order.referenceNumber} has already been dispatched.`);
  }

  // Not a hard block. A shop that hands orders to a rider who already knows the
  // street should not be stopped by a missing column, but the owner should know
  // the rider is leaving without an address.
  if (!order.deliveryAddress) {
    logger.info(
      { orderId, reference: order.referenceNumber },
      'Order dispatched with no delivery address on record',
    );
  }

  const row = await prisma.shipment.upsert({
    where: { orderId },
    create: {
      businessId,
      orderId,
      courier: input.courier ?? null,
      trackingNumber: input.trackingNumber ?? null,
      notes: input.notes ?? null,
      dispatchedAt: new Date(),
      createdByStaffId: actorId,
    },
    update: {
      courier: input.courier ?? null,
      trackingNumber: input.trackingNumber ?? null,
      notes: input.notes ?? null,
      dispatchedAt: new Date(),
    },
    select: SHIPMENT_SELECT,
  });

  // Transitions, notifies the customer and writes the status history, all
  // through the one path that already knows how to do those things.
  await dispatchOrderStatus(orderId, businessId, actorId);

  if (actorId) {
    await logActivity({
      staffId: actorId,
      action: 'order.dispatched',
      resourceId: orderId,
      resourceType: 'order',
      note:
        `Order ${order.referenceNumber} dispatched` +
        (input.courier ? ` with ${input.courier}` : '') +
        (input.trackingNumber ? ` (${input.trackingNumber})` : ''),
    }).catch(() => {});
  }

  return toView(row);
}

/**
 * Attaches the photo the rider took.
 *
 * Same base64-over-JSON path and the same 5 MB validator product photos use,
 * rather than a second upload mechanism with its own size rules and its own
 * bugs.
 */
export async function attachProofOfDispatch(
  orderId: string,
  businessId: string,
  actorId: string | null,
  encoded: string,
): Promise<ShipmentView> {
  if (!features.mediaStorage) {
    throw new ValidationError(
      'Photo storage is not set up on this deployment yet, so the proof could not be saved.',
    );
  }

  const order = await requireOrder(orderId, businessId);

  const existing = await prisma.shipment.findUnique({
    where: { orderId },
    select: { proofKey: true },
  });
  if (!existing) {
    throw new ValidationError(
      `${order.referenceNumber} has not been dispatched yet, so there is nothing to prove.`,
    );
  }

  const inspection = inspectImageUpload(encoded);
  if (!inspection.ok) throw new ValidationError(describeRejection(inspection.reason));

  const { buffer, mimeType } = inspection.image;
  const extension = mimeType.split('/')[1] ?? 'jpg';
  const key = `dispatch/${businessId}/${orderId}-${Date.now()}.${extension}`;

  await uploadBufferToS3(buffer, key, mimeType);

  try {
    const row = await prisma.shipment.update({
      where: { orderId },
      // Written together because the CHECK constraint on the table will not
      // accept one without the other.
      data: { proofKey: key, proofMimeType: mimeType, proofUploadedAt: new Date() },
      select: SHIPMENT_SELECT,
    });

    // The object it replaced is now unreachable. Deleted after the row is
    // updated, not before, so a failed write never leaves the row pointing at
    // something that has already been removed.
    if (existing.proofKey && existing.proofKey !== key) {
      await deleteObject(existing.proofKey).catch(() => {});
    }

    if (actorId) {
      await logActivity({
        staffId: actorId,
        action: 'order.proof_uploaded',
        resourceId: orderId,
        resourceType: 'order',
        note: `Proof of dispatch added to ${order.referenceNumber}`,
      }).catch(() => {});
    }

    return toView(row);
  } catch (error: unknown) {
    logger.error({ error, orderId, key }, 'Proof row failed after the object was written');
    await deleteObject(key).catch(() => {});
    throw error;
  }
}

/** The object key, for the endpoint that streams the proof back. */
export async function getProofKey(
  orderId: string,
  businessId: string,
): Promise<{ key: string; mimeType: string } | null> {
  const row = await prisma.shipment.findFirst({
    where: { orderId, businessId },
    select: { proofKey: true, proofMimeType: true },
  });
  if (!row?.proofKey) return null;
  return { key: row.proofKey, mimeType: row.proofMimeType ?? 'image/jpeg' };
}

/** Marks arrival and completes the order. */
export async function markShipmentDelivered(
  orderId: string,
  businessId: string,
  actorId: string | null,
): Promise<ShipmentView> {
  const order = await requireOrder(orderId, businessId);

  const row = await prisma.shipment
    .update({ where: { orderId }, data: { deliveredAt: new Date() }, select: SHIPMENT_SELECT })
    .catch(() => {
      throw new ValidationError(`${order.referenceNumber} has not been dispatched yet.`);
    });

  if (order.status !== 'FULFILLED') {
    await fulfillOrder(orderId, businessId, actorId);
  }

  return toView(row);
}
