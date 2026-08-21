import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



/** Mirrors the API's StaffRole enum — a union, so typos fail at compile time. */
export type StaffRole = 'MANAGER' | 'OPERATIONS' | 'DELIVERY';

export interface StaffMember {
  id: string;
  name: string;
  phone: string;
  role: StaffRole;
  active: boolean;
  inviteAcceptedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export function useStaff(): UseQueryResult<StaffMember[], Error> {
  return useQuery({
    queryKey: ['staff'],
    queryFn: () => apiFetch<StaffMember[]>('/staff'),
    staleTime: 30_000,
  });
}

export interface InviteStaffInput {
  name: string;
  phone: string;
  role: StaffRole;
}

export function useInviteStaff(): UseMutationResult<StaffMember, Error, InviteStaffInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: InviteStaffInput) =>
      apiFetch<StaffMember>('/staff/invite', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });
}

/** Either field alone is a valid change, so both are optional here. */
export interface UpdateStaffInput {
  role?: StaffRole;
  active?: boolean;
}

/**
 * Changes a staff member's role, or switches their access off.
 *
 * Both take effect the instant this resolves — the API deletes their refresh
 * sessions and bumps a revocation epoch, so an access token already on their
 * phone stops working rather than lasting out its fifteen minutes. That is why
 * the calling UI says "signed out immediately" and means it.
 */
export function useUpdateStaff(): UseMutationResult<
  StaffMember,
  Error,
  { id: string; data: UpdateStaffInput }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateStaffInput }) =>
      apiFetch<StaffMember>(`/staff/${id}`, { method: 'PATCH', body: data }),
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: ['staff'] });
      // A deactivation or a role change is itself an auditable act, so the log
      // this person appears in is stale the moment it lands.
      qc.invalidateQueries({ queryKey: ['staff', 'activity', id] });
    },
  });
}

/** One line of the audit trail: who did what, to which record, when. */
export interface StaffActivityEntry {
  id: string;
  staffId: string;
  /** A dotted verb, e.g. `order.confirmed`, `payment.voided`. */
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * One staff member's audit trail, newest first.
 *
 * Not cached for long. This is read when something has gone wrong and the owner
 * is trying to establish what happened; a two-minute-old answer to that question
 * is worse than no answer.
 */
export function useStaffActivity(
  staffId: string | null,
): UseQueryResult<StaffActivityEntry[], Error> {
  return useQuery({
    queryKey: ['staff', 'activity', staffId],
    queryFn: () => apiFetch<StaffActivityEntry[]>(`/staff/${staffId}/activity`),
    enabled: !!staffId,
    staleTime: 10_000,
  });
}
