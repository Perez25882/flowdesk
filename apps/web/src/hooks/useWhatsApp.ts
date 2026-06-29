import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BUSINESS_QUERY_KEY } from './useBusiness';

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

export interface WhatsAppConfig {
  appId: string;
  configId: string | null;
  apiVersion: string;
  embeddedSignupEnabled: boolean;
}

export interface WhatsAppStatus {
  connected: boolean;
  waPhoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  webhookVerified: boolean;
}

export interface EmbeddedSignupPayload {
  code: string;
  phoneNumberId: string;
  wabaId?: string;
}

export interface ManualConnectPayload {
  phoneNumberId: string;
  accessToken: string;
}

const WHATSAPP_STATUS_KEY = ['whatsapp', 'status'] as const;
const WHATSAPP_CONFIG_KEY = ['whatsapp', 'config'] as const;

export function useWhatsAppConfig() {
  return useQuery({
    queryKey: WHATSAPP_CONFIG_KEY,
    queryFn: () => fetchJson<WhatsAppConfig>('/whatsapp/config'),
    staleTime: 5 * 60_000,
  });
}

export function useWhatsAppStatus() {
  return useQuery({
    queryKey: WHATSAPP_STATUS_KEY,
    queryFn: () => fetchJson<WhatsAppStatus>('/whatsapp/status'),
    staleTime: 30_000,
  });
}

function useInvalidateOnConnect() {
  const qc = useQueryClient();
  return (data: WhatsAppStatus) => {
    qc.setQueryData(WHATSAPP_STATUS_KEY, data);
    qc.invalidateQueries({ queryKey: ['business'] });
    qc.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
  };
}

export function useConnectWhatsApp() {
  const onConnected = useInvalidateOnConnect();
  return useMutation({
    mutationFn: (payload: EmbeddedSignupPayload) =>
      fetchJson<WhatsAppStatus>('/whatsapp/connect', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: onConnected,
  });
}

export function useConnectWhatsAppManual() {
  const onConnected = useInvalidateOnConnect();
  return useMutation({
    mutationFn: (payload: ManualConnectPayload) =>
      fetchJson<WhatsAppStatus>('/whatsapp/connect/manual', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: onConnected,
  });
}

export function useDisconnectWhatsApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson<{ connected: boolean }>('/whatsapp/disconnect', { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WHATSAPP_STATUS_KEY });
      qc.invalidateQueries({ queryKey: ['business'] });
      qc.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
    },
  });
}
