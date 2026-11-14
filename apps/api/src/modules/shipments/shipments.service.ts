import { randomUUID } from 'node:crypto';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { features } from '../../config/env.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { describeRejection, inspectImageUpload } from '../../services/media/image-file.js';
import { uploadBufferToS3 } from '../../services/s3/media.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import {
  lockOrderForDelivery,
  orderAccessWhere,
  requireOrderAccess,
  type OrderActor,
} from '../orders/orders.authorization.js';
import { transitionDeliveryOrder } from '../orders/orders.service.js';
import type { DispatchOrderInput } from './shipments.schema.js';

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

function toView(row: Omit<ShipmentView, 'hasProof'> & { proofKey: string | null }): ShipmentView {
  const { proofKey, ...rest } = row;
  return { ...rest, hasProof: proofKey !== null };
}

export async function getShipmentForOrder(
  orderId: string,
  actor: OrderActor,
): Promise<ShipmentView | null> {
  await requireOrderAccess(orderId, actor, 'orders.read');
  const row = await prisma.shipment.findFirst({
    where: { orderId, businessId: actor.businessId, order: orderAccessWhere(orderId, actor, 'orders.read') },
    select: SHIPMENT_SELECT,
  });
  return row ? toView(row) : null;
}

/** Commit shipment metadata and the order transition before customer notification. */
export async function dispatchOrder(
  orderId: string,
  actor: OrderActor,
  input: DispatchOrderInput,
): Promise<ShipmentView> {
  const { businessId, staffId } = actor;
  const { shipment } = await transitionDeliveryOrder(orderId, actor, 'DISPATCHED', async (tx, order) => {
    const existing = await tx.shipment.findUnique({ where: { orderId }, select: { ...SHIPMENT_SELECT, businessId: true } });
    if (existing && existing.businessId !== businessId) throw new NotFoundError('Order not found');
    if (order.status === 'DISPATCHED') {
      if (!existing) throw new ValidationError('Dispatched order has no shipment');
      const { businessId: _owner, ...shipment } = existing;
      return shipment;
    }

    if (!order.deliveryAddress) {
      logger.info({ orderId, reference: order.referenceNumber }, 'Dispatch has no delivery address');
    }

    const data = {
      courier: input.courier ?? null,
      trackingNumber: input.trackingNumber ?? null,
      notes: input.notes ?? null,
      dispatchedAt: new Date(),
    };
    return tx.shipment.upsert({
      where: { orderId, businessId },
      create: { ...data, businessId, orderId, createdByStaffId: staffId },
      update: data,
      select: SHIPMENT_SELECT,
    });
  });
  return toView(shipment);
}

export async function attachProofOfDispatch(
  orderId: string,
  actor: OrderActor,
  encoded: string,
): Promise<ShipmentView> {
  await requireOrderAccess(orderId, actor, 'orders.transition');
  if (!features.mediaStorage) {
    throw new ValidationError(
      'Photo storage is not set up on this deployment yet, so the proof could not be saved.',
    );
  }

  const { businessId, staffId } = actor;
  const where = { orderId, businessId };
  const existing = await prisma.shipment.findFirst({
    where: { ...where, order: orderAccessWhere(orderId, actor, 'orders.transition') },
    select: { id: true },
  });
  if (!existing) {
    await requireOrderAccess(orderId, actor, 'orders.transition');
    throw new ValidationError('This order has not been dispatched yet, so there is nothing to prove.');
  }

  const inspection = inspectImageUpload(encoded);
  if (!inspection.ok) throw new ValidationError(describeRejection(inspection.reason));
  const { buffer, mimeType } = inspection.image;
  const extension = mimeType.split('/')[1];
  const key = `dispatch/${businessId}/${orderId}/${randomUUID()}.${extension}`;
  const staged = await prisma.fulfillmentTask.create({
    data: { businessId, orderId, kind: 'DELETE_PROOF', subject: key, nextAttemptAt: new Date(Date.now() + 120_000) },
  });

  // Stage a private object without holding a database lock during storage I/O.
  // Recheck authorization before publishing its key and remove it on failure.
  let uploaded = false;
  let result;
  try {
    await uploadBufferToS3(buffer, key, mimeType, AbortSignal.timeout(10_000));
    uploaded = true;
    result = await prisma.$transaction(async (tx) => {
      await lockOrderForDelivery(tx, orderId, actor);
      const previous = await tx.shipment.findUnique({ where, select: { proofKey: true } });
      if (!previous) throw new NotFoundError('Order not found');
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId, businessId }, select: { status: true } });
      if (order.status === 'CANCELLED') throw new ValidationError('A cancelled shipment cannot receive proof');
      const row = await tx.shipment.update({
        where,
        data: { proofKey: key, proofMimeType: mimeType, proofUploadedAt: new Date() },
        select: SHIPMENT_SELECT,
      });
      await tx.fulfillmentTask.update({ where: { id: staged.id }, data: { state: 'DONE', nextAttemptAt: null } });
      if (previous.proofKey && isOrderProofKey(previous.proofKey, businessId, orderId)) {
        await tx.fulfillmentTask.upsert({
          where: { businessId_orderId_kind_subject: { businessId, orderId, kind: 'DELETE_PROOF', subject: previous.proofKey } },
          create: { businessId, orderId, kind: 'DELETE_PROOF', subject: previous.proofKey },
          update: { state: 'PENDING', nextAttemptAt: new Date() },
        });
      }
      if (staffId) await logActivity({
        staffId, businessId, action: 'order.proof_uploaded', resourceId: orderId, resourceType: 'order',
        note: 'Proof of dispatch added',
      }, tx);
      return row;
    });
  } catch (error: unknown) {
    await prisma.fulfillmentTask.updateMany({ where: { id: staged.id, state: 'PENDING' },
      data: { reason: uploaded ? 'PROOF_LINK_INTERRUPTED' : 'PROOF_UPLOAD_UNCERTAIN' } }).catch(() => undefined);
    throw error;
  }

  return toView(result);
}

export function isOrderProofKey(key: string, businessId: string, orderId: string): boolean {
  const prefix = `dispatch/${businessId}/${orderId}`;
  if (!key.startsWith(prefix)) return false;
  // Existing objects used a timestamp suffix. New objects use a per-order path.
  return /^(?:-\d+|\/[\da-f-]{36})\.(?:jpeg|png|webp)$/.test(key.slice(prefix.length));
}

/** Resolve the private object only through the authorized order. */
export async function getProofKey(
  orderId: string,
  actor: OrderActor,
): Promise<{ key: string; mimeType: string } | null> {
  await requireOrderAccess(orderId, actor, 'orders.read');
  const row = await prisma.shipment.findFirst({
    where: { orderId, businessId: actor.businessId, order: orderAccessWhere(orderId, actor, 'orders.read') },
    select: { proofKey: true, proofMimeType: true },
  });
  if (!row?.proofKey || !isOrderProofKey(row.proofKey, actor.businessId, orderId)) return null;
  return { key: row.proofKey, mimeType: row.proofMimeType ?? 'image/jpeg' };
}

export async function markShipmentDelivered(orderId: string, actor: OrderActor): Promise<ShipmentView> {
  const { shipment } = await transitionDeliveryOrder(orderId, actor, 'FULFILLED', async (tx, order) => {
    const where = { orderId, businessId: actor.businessId };
    const existing = await tx.shipment.findUnique({ where, select: SHIPMENT_SELECT });
    if (!existing) throw new ValidationError(`${order.referenceNumber} has not been dispatched yet.`);
    if (existing.deliveredAt) return existing;
    return tx.shipment.update({ where, data: { deliveredAt: new Date() }, select: SHIPMENT_SELECT });
  }, true);
  return toView(shipment);
}
