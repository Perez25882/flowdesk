import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES, hasCapability, isAssignmentScoped } from '@flowdesk/shared';

/**
 * The authorization matrix.
 *
 * These assertions exist because every mutating route once ran with only an
 * authentication check: a delivery rider could log a verified payment, delete
 * the record of one, and read the whole customer list. The specific denials
 * below are the ones that mattered, so they are asserted by name rather than
 * inferred from the table.
 */

describe('capability matrix', () => {
  describe('the owner', () => {
    it('holds every capability', () => {
      // The owner has no staff row and therefore no role.
      expect(hasCapability(undefined, 'payments.delete')).toBe(true);
      expect(hasCapability(undefined, 'billing.manage')).toBe(true);
      expect(hasCapability(undefined, 'staff.manage')).toBe(true);
    });
  });

  describe('a delivery rider', () => {
    it('can read and transition orders', () => {
      expect(hasCapability('DELIVERY', 'orders.read')).toBe(true);
      expect(hasCapability('DELIVERY', 'orders.transition')).toBe(true);
    });

    it('cannot touch money', () => {
      expect(hasCapability('DELIVERY', 'payments.create')).toBe(false);
      expect(hasCapability('DELIVERY', 'payments.verify')).toBe(false);
      expect(hasCapability('DELIVERY', 'payments.delete')).toBe(false);
      expect(hasCapability('DELIVERY', 'revenue.read')).toBe(false);
    });

    it('cannot read the customer list', () => {
      expect(hasCapability('DELIVERY', 'customers.read')).toBe(false);
      expect(hasCapability('DELIVERY', 'customers.write')).toBe(false);
    });

    it('cannot read or manage the staff roster', () => {
      expect(hasCapability('DELIVERY', 'staff.read')).toBe(false);
      expect(hasCapability('DELIVERY', 'staff.manage')).toBe(false);
    });

    it('cannot change the catalogue', () => {
      expect(hasCapability('DELIVERY', 'products.write')).toBe(false);
      expect(hasCapability('DELIVERY', 'products.delete')).toBe(false);
    });

    it('is scoped to its own assignments', () => {
      expect(isAssignmentScoped('DELIVERY')).toBe(true);
    });
  });

  describe('counter staff', () => {
    it('can record a payment but not confirm or erase one', () => {
      expect(hasCapability('OPERATIONS', 'payments.create')).toBe(true);
      expect(hasCapability('OPERATIONS', 'payments.verify')).toBe(false);
      expect(hasCapability('OPERATIONS', 'payments.delete')).toBe(false);
    });

    it('cannot delete products or manage staff', () => {
      expect(hasCapability('OPERATIONS', 'products.delete')).toBe(false);
      expect(hasCapability('OPERATIONS', 'staff.manage')).toBe(false);
    });

    it('sees the whole order book, not just its own', () => {
      expect(isAssignmentScoped('OPERATIONS')).toBe(false);
    });
  });

  describe('a manager', () => {
    it('runs the shop', () => {
      expect(hasCapability('MANAGER', 'payments.delete')).toBe(true);
      expect(hasCapability('MANAGER', 'staff.manage')).toBe(true);
      expect(hasCapability('MANAGER', 'products.delete')).toBe(true);
      expect(hasCapability('MANAGER', 'revenue.read')).toBe(true);
    });

    it('cannot pay for the product or revoke everyone else', () => {
      expect(hasCapability('MANAGER', 'billing.manage')).toBe(false);
      expect(hasCapability('MANAGER', 'sessions.revokeAll')).toBe(false);
    });
  });

  describe('the table itself', () => {
    it('grants billing to no staff role — it is the owner\'s alone', () => {
      for (const [role, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
        expect(capabilities, `${role} must not hold billing.manage`).not.toContain('billing.manage');
      }
    });

    it('refuses an unknown role rather than defaulting open', () => {
      // A staff token carrying a role we do not recognise must not be treated
      // as an owner. Only `undefined` means owner.
      expect(hasCapability('SUPERUSER' as never, 'payments.delete')).toBe(false);
    });
  });
});
