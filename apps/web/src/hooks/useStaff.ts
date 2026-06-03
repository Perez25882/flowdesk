import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API_BASE = '/api/v1';

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('accessToken');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.data as T;
}

export interface StaffMember {
  id: string;
  name: string;
  phone: string;
  role: string;
  active: boolean;
  inviteAcceptedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export function useStaff() {
  return useQuery({
    queryKey: ['staff'],
    queryFn: () => fetchJson<StaffMember[]>('/staff'),
    staleTime: 30_000,
  });
}

export function useInviteStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; phone: string; role: string }) =>
      fetchJson<StaffMember>('/staff/invite', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });
}
