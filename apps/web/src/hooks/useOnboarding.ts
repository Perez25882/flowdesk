import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type OnboardingStepId =
  | 'profile' | 'hours' | 'policies' | 'team' | 'whatsapp'
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
  profile: SetupProfile | null;
  profileRevision: number;
  steps: OnboardingStep[];
  completed: number;
  total: number;
  ready: boolean;
  providers: { whatsapp: ProviderState; payments: ProviderState };
}

export type SetupProfile = 'ONLINE_RETAIL' | 'CUSTOM_ORDER' | 'APPOINTMENT' | 'PROFESSIONAL_SERVICES';
type ProviderState = 'NOT_CONFIGURED' | 'INCOMPLETE' | 'LOCAL_VALIDATION' | 'VERIFICATION_PENDING' | 'VERIFIED' | 'ERROR' | 'DISABLED';
export const providerLabels: Record<ProviderState, string> = {
  NOT_CONFIGURED: 'Not configured', INCOMPLETE: 'Configuration incomplete', LOCAL_VALIDATION: 'Validated in this environment',
  VERIFICATION_PENDING: 'Provider verification pending', VERIFIED: 'Independently verified', ERROR: 'Connection error', DISABLED: 'Disabled',
};

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
