import { describe, expect, it } from 'vitest';
import { toPublicStaff } from '../src/modules/staff/staff.dto.js';
import type { StaffMember } from '../src/modules/staff/staff.repository.js';

/**
 * The public staff shape must never carry secrets.
 *
 * `GET /staff`, invite, accept and login all returned the raw DB row, which
 * includes `passwordHash` (a bcrypt hash any manager could take offline to
 * crack) and `inviteToken` (a live credential). `toPublicStaff` is the single
 * boundary that strips them.
 */
const fullRow: StaffMember = {
  id: 'staff_1',
  businessId: 'biz_1',
  name: 'Rider Rico',
  phone: '233555000111',
  role: 'DELIVERY',
  active: true,
  passwordHash: '$2b$12$examplehashvaluethatmustnotleak',
  inviteToken: 'a-live-invite-token',
  inviteExpiry: new Date('2026-01-08T00:00:00Z'),
  inviteAcceptedAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: new Date('2026-01-02T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('toPublicStaff', () => {
  it('omits the password hash', () => {
    const dto = toPublicStaff(fullRow) as Record<string, unknown>;
    expect('passwordHash' in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('examplehash');
  });

  it('omits the invite token', () => {
    const dto = toPublicStaff(fullRow) as Record<string, unknown>;
    expect('inviteToken' in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('a-live-invite-token');
  });

  it('keeps the fields a client legitimately needs', () => {
    const dto = toPublicStaff(fullRow);
    expect(dto).toEqual({
      id: 'staff_1',
      businessId: 'biz_1',
      name: 'Rider Rico',
      phone: '233555000111',
      role: 'DELIVERY',
      active: true,
      inviteAcceptedAt: fullRow.inviteAcceptedAt,
      lastLoginAt: fullRow.lastLoginAt,
      createdAt: fullRow.createdAt,
    });
  });

  it('exposes exactly nine fields — a new secret column cannot silently ride along', () => {
    // If someone adds a sensitive column to StaffMember, this count trips until
    // they consciously decide whether it belongs in the public shape.
    expect(Object.keys(toPublicStaff(fullRow)).length).toBe(9);
  });
});
