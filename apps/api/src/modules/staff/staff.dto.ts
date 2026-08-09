import type { StaffMember } from './staff.repository.js';

/**
 * A staff record safe to send to a client.
 *
 * The DB row carries `passwordHash` and `inviteToken`. Those were serialised
 * straight into every `/staff` response, handing a manager every co-worker's
 * bcrypt hash for offline cracking and leaking live invite tokens. Every
 * response goes through `toPublicStaff`, so those two fields can never leave the
 * server. Kept dependency-free so it is trivially testable.
 */
export interface PublicStaff {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  role: StaffMember['role'];
  active: boolean;
  inviteAcceptedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toPublicStaff(staff: StaffMember): PublicStaff {
  return {
    id: staff.id,
    businessId: staff.businessId,
    name: staff.name,
    phone: staff.phone,
    role: staff.role,
    active: staff.active,
    inviteAcceptedAt: staff.inviteAcceptedAt,
    lastLoginAt: staff.lastLoginAt,
    createdAt: staff.createdAt,
  };
}
