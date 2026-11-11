import { hasCapability, type Capability } from '@flowdesk/shared';
import type { Prisma, StaffRole } from '@prisma/client';
import { lockCustomerForTotals } from '../customers/customers.repository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';

export interface PaymentRelationship {
  businessId: string;
  customerId: string;
  orderId?: string | null | undefined;
}

/** Lock the customer before the order to serialize payment and balance writes. */
export async function lockPaymentRelationship(
  tx: Prisma.TransactionClient,
  { businessId, customerId, orderId }: PaymentRelationship,
  allowArchived = false,
): Promise<void> {
  const customer = await lockCustomerForTotals(tx, customerId, businessId);
  if (!customer || (!allowArchived && customer.deletedAt)) throw new NotFoundError('Customer not found');
  if (orderId === null || orderId === undefined) return;

  const [order] = await tx.$queryRaw<Array<{ customerId: string; deletedAt: Date | null }>>`
    SELECT "customerId", "deletedAt" FROM orders
    WHERE id = ${orderId} AND "businessId" = ${businessId}
    FOR NO KEY UPDATE
  `;
  if (!order || (!allowArchived && order.deletedAt)) throw new NotFoundError('Order not found');
  if (order.customerId !== customerId) throw new ValidationError('Order does not belong to this customer');
}

export async function requirePaymentActor(
  tx: Prisma.TransactionClient,
  businessId: string,
  staffId: string | null,
  capability: Capability,
): Promise<void> {
  if (staffId === null) return;
  const [staff] = await tx.$queryRaw<Array<{ role: StaffRole }>>`
    SELECT role::text AS role FROM staff WHERE id = ${staffId} AND "businessId" = ${businessId} AND active FOR SHARE
  `;
  if (!staff || !hasCapability(staff.role, capability)) {
    throw new ForbiddenError('You do not have permission to perform this action');
  }
}
