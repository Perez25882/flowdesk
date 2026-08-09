import { describe, expect, it } from 'vitest';
import { assignmentFor } from '../src/modules/orders/orders.service.js';

/**
 * Who a transition is attributed to.
 *
 * `Order.assignedStaffId` and `StaffActivity.staffId` are foreign keys to the
 * Staff table. The owner has no staff row — the Business row *is* their
 * account — so the actor for an owner action is null, not a placeholder.
 *
 * The route used to substitute the literal string `'system'`, which meant
 * moving an order to Packing tried to assign it to a staff member named
 * "system". Every owner hit a 500 on that transition, and the matching audit
 * write failed silently behind a `.catch`, so owner actions were never logged.
 */
describe('order transition actor', () => {
  it('assigns the order when a real staff member is packing it', () => {
    expect(assignmentFor('staff_abc123')).toEqual({ assignStaffId: 'staff_abc123' });
  });

  it('assigns nobody when the owner is packing it', () => {
    // The absence of the key matters: an explicit undefined would still be sent
    // to Prisma under exactOptionalPropertyTypes.
    expect(assignmentFor(null)).toEqual({});
    expect(Object.hasOwn(assignmentFor(null), 'assignStaffId')).toBe(false);
  });

  it('never produces a placeholder staff id', () => {
    for (const actor of [null, '', 'staff_1']) {
      const result = assignmentFor(actor as string | null);
      expect(result.assignStaffId).not.toBe('system');
      expect(result.assignStaffId).not.toBe('owner');
    }
  });

  it('treats an empty string as no staff member rather than an id', () => {
    expect(assignmentFor('')).toEqual({});
  });
});
