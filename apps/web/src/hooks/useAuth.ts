import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

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

export interface MetaAuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface MetaSignupPayload {
  code: string;
  phoneNumberId: string;
  wabaId?: string;
}

export function useMetaSignup(): UseMutationResult<MetaAuthTokens, Error, MetaSignupPayload, unknown> {
  const qc = useQueryClient();
  return useMutation<MetaAuthTokens, Error, MetaSignupPayload, unknown>({
    mutationFn: (payload: MetaSignupPayload) =>
      fetchJson<MetaAuthTokens>('/auth/meta/signup', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

export function useMetaLogin(): UseMutationResult<MetaAuthTokens, Error, string, unknown> {
  const qc = useQueryClient();
  return useMutation<MetaAuthTokens, Error, string, unknown>({
    mutationFn: (code: string) =>
      fetchJson<MetaAuthTokens>('/auth/meta/login', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    onSuccess: (data) => {
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

export function useRefreshToken(): UseMutationResult<{ accessToken: string; refreshToken: string }, Error, void, unknown> {
  return useMutation<{ accessToken: string; refreshToken: string }, Error, void, unknown>({
    mutationFn: () => {
      const refreshToken = localStorage.getItem('refreshToken');
      return fetchJson<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
    },
    onSuccess: (data) => {
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
    },
  });
}

export function useLogout(): UseMutationResult<{ message: string }, Error, void, unknown> {
  const qc = useQueryClient();
  return useMutation<{ message: string }, Error, void, unknown>({
    mutationFn: () => fetchJson<{ message: string }>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      qc.clear();
    },
  });
}

export function getAccessToken(): string | null {
  return localStorage.getItem('accessToken');
}

export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

interface DecodedToken {
  businessId: string;
  staffId?: string;
  role?: string;
  plan?: string;
  exp?: number;
}

export function decodeToken(): DecodedToken | null {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload)) as DecodedToken;
    return decoded;
  } catch {
    return null;
  }
}

export function getUserRole(): string | null {
  return decodeToken()?.role ?? null;
}

export function isOwner(): boolean {
  const decoded = decodeToken();
  return decoded !== null && !decoded.staffId;
}

export function isDeliveryStaff(): boolean {
  return getUserRole() === 'DELIVERY';
}

export function isOperationsStaff(): boolean {
  return getUserRole() === 'OPERATIONS';
}

export function isManager(): boolean {
  return getUserRole() === 'MANAGER';
}

export function canAccessRevenue(): boolean {
  const role = getUserRole();
  return role === 'MANAGER' || isOwner();
}

export function canAccessStaffManagement(): boolean {
  const role = getUserRole();
  return role === 'MANAGER' || isOwner();
}
