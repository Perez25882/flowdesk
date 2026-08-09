import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { BUSINESS_QUERY_KEY } from './useBusiness';

export interface WhatsAppConfig {
  appId: string;
  configId: string | null;
  apiVersion: string;
  embeddedSignupEnabled: boolean;
  environment: 'development' | 'test' | 'production';
}

/**
 * Health of this business's own WhatsApp connection.
 *
 * ACTIVE is the only state in which automatic replies go out. The others are
 * shown to the owner with an explanation, because a silently dead connection
 * looks exactly like "no customers messaged today".
 */
export type WhatsAppConnectionState =
  | 'DISCONNECTED'
  | 'ACTIVE'
  | 'TOKEN_INVALID'
  | 'NUMBER_UNAVAILABLE'
  | 'RATE_LIMITED';

export interface WhatsAppStatus {
  connected: boolean;
  waPhoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  webhookVerified: boolean;
  state: WhatsAppConnectionState;
  error: string | null;
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

export function useWhatsAppConfig(): UseQueryResult<WhatsAppConfig, Error> {
  return useQuery({
    queryKey: WHATSAPP_CONFIG_KEY,
    queryFn: () => apiFetch<WhatsAppConfig>('/whatsapp/config'),
    staleTime: 5 * 60_000,
  });
}

export function useWhatsAppStatus(): UseQueryResult<WhatsAppStatus, Error> {
  return useQuery({
    queryKey: WHATSAPP_STATUS_KEY,
    queryFn: () => apiFetch<WhatsAppStatus>('/whatsapp/status'),
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

export function useConnectWhatsApp(): UseMutationResult<WhatsAppStatus, Error, EmbeddedSignupPayload> {
  const onConnected = useInvalidateOnConnect();
  return useMutation({
    mutationFn: (payload: EmbeddedSignupPayload) =>
      apiFetch<WhatsAppStatus>('/whatsapp/connect', { method: 'POST', body: payload }),
    onSuccess: onConnected,
  });
}

export function useConnectWhatsAppManual(): UseMutationResult<WhatsAppStatus, Error, ManualConnectPayload> {
  const onConnected = useInvalidateOnConnect();
  return useMutation({
    mutationFn: (payload: ManualConnectPayload) =>
      apiFetch<WhatsAppStatus>('/whatsapp/connect/manual', { method: 'POST', body: payload }),
    onSuccess: onConnected,
  });
}

export function useDisconnectWhatsApp(): UseMutationResult<{ connected: boolean }, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ connected: boolean }>('/whatsapp/disconnect', { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WHATSAPP_STATUS_KEY });
      qc.invalidateQueries({ queryKey: ['business'] });
      qc.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
    },
  });
}
