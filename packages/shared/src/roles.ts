/**
 * The authorization matrix, shared by the API and the dashboard.
 *
 * The API enforces this; the dashboard uses the same table to decide what to
 * render. Stating it once is the point — when the two were written separately
 * the dashboard hid the staff-management screen from delivery riders while the
 * API happily served every one of its endpoints to them.
 *
 * Hiding a control is never the control. Every capability here is checked on
 * the server; the client copy only avoids showing buttons that would 403.
 */

export type StaffRole = 'MANAGER' | 'OPERATIONS' | 'DELIVERY';

export type Capability =
  | 'orders.read'
  | 'orders.create'
  | 'orders.transition'
  | 'orders.assign'
  | 'products.read'
  | 'products.write'
  | 'products.delete'
  | 'customers.read'
  | 'customers.write'
  | 'payments.read'
  | 'payments.create'
  | 'payments.verify'
  | 'payments.delete'
  | 'messages.read'
  | 'messages.write'
  | 'staff.read'
  | 'staff.manage'
  | 'settings.read'
  | 'settings.write'
  | 'revenue.read'
  | 'billing.manage'
  | 'sessions.revokeAll';

/**
 * Capabilities granted to each staff role.
 *
 * The owner is not listed: owners hold every capability implicitly, because the
 * Business row *is* the owner's account and there is no staff record to carry a
 * role. See `hasCapability`.
 */
export const ROLE_CAPABILITIES: Record<StaffRole, readonly Capability[]> = {
  /**
   * Runs the shop day to day. Everything except the two things that belong to
   * the account holder alone: paying for the product, and revoking everyone's
   * sessions.
   */
  MANAGER: [
    'orders.read',
    'orders.create',
    'orders.transition',
    'orders.assign',
    'products.read',
    'products.write',
    'products.delete',
    'customers.read',
    'customers.write',
    'payments.read',
    'payments.create',
    'payments.verify',
    'payments.delete',
    'messages.read',
    'messages.write',
    'staff.read',
    'staff.manage',
    'settings.read',
    'settings.write',
    'revenue.read',
  ],

  /**
   * Counter staff. Takes orders, updates stock, records payments — but cannot
   * verify or delete a payment. Recording and confirming money are deliberately
   * separate hands.
   */
  OPERATIONS: [
    'orders.read',
    'orders.create',
    'orders.transition',
    'orders.assign',
    'products.read',
    'products.write',
    'customers.read',
    'customers.write',
    'payments.read',
    'payments.create',
    'messages.read',
    'messages.write',
    'settings.read',
  ],

  /**
   * Riders. Sees the orders assigned to them and moves those along. No customer
   * list, no product catalogue, no money — a delivery account is the one most
   * likely to be used on a borrowed or lost phone.
   */
  DELIVERY: ['orders.read', 'orders.transition'],
};

/**
 * Resolves a capability for a caller.
 *
 * `role` is undefined for the business owner, who holds everything. A staff
 * token always carries a role, so an undefined role on a staff account is a
 * malformed token rather than an owner — callers must establish ownership from
 * the absence of a staff id, not from a missing role.
 */
export function hasCapability(role: StaffRole | undefined, capability: Capability): boolean {
  if (role === undefined) {
    return true;
  }

  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

/**
 * True when the role only ever sees its own assigned orders.
 *
 * Riders are scoped to their assignments rather than the whole order book; the
 * repository takes a staff id, so this returns the decision and the caller
 * supplies the id.
 */
export function isAssignmentScoped(role: StaffRole | undefined): boolean {
  return role === 'DELIVERY';
}
