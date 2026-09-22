import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type OnboardingStepId =
  | 'whatsapp'
  | 'shop'
  | 'facts'
  | 'catalogue'
  | 'payouts'
  | 'assistant';

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  why: string;
  done: boolean;
  blocking: boolean;
  href: string;
  warning?: string;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  ready: boolean;
}

/**
 * Setup progress, derived server-side from what is actually configured.
 *
 * Refetched on window focus without a stale window, because the whole point is
 * that it reflects reality: an owner who connects WhatsApp in another tab and
 * comes back should not still be told to connect WhatsApp.
 */
export function useOnboarding(): UseQueryResult<OnboardingState, Error> {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: () => apiFetch<OnboardingState>('/onboarding'),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
