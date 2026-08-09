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
