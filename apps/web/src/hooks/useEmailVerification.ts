import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface IssuedCode {
  expiresAt: string;
  /** False when the deployment has no email provider configured. */
  delivered: boolean;
}

export function useRequestEmailCode(): UseMutationResult<IssuedCode, Error, void> {
  return useMutation({
    mutationFn: () =>
      apiFetch<IssuedCode>('/auth/verify-email/request', { method: 'POST', body: {} }),
  });
}

export function useConfirmEmailCode(): UseMutationResult<{ message: string }, Error, string> {
  return useMutation({
    mutationFn: (code: string) =>
      apiFetch<{ message: string }>('/auth/verify-email/confirm', {
        method: 'POST',
        body: { code },
      }),
  });
}
