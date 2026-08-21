import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type BillablePlan = 'STARTER' | 'BUSINESS' | 'GROWTH';

export interface CheckoutResponse {
  authorizationUrl: string;
  reference: string;
}

/**
 * The code the API returns when a subscriber picks a cheaper tier at checkout.
 *
 * The frontend routes downgrades to `/billing/downgrade` by comparing tiers
 * before it ever calls checkout, so this should not be reachable. It is handled
 * anyway: the tier table here and the one on the server are two copies of the
 * same fact, and the server's is the one that decides.
 */
export const PLAN_DOWNGRADE_REQUIRED = 'PLAN_DOWNGRADE_REQUIRED';

/** Cheapest first. Used to tell an upgrade from a downgrade before calling. */
const PLAN_RANK: Record<BillablePlan, number> = {
  STARTER: 0,
  BUSINESS: 1,
  GROWTH: 2,
};

/**
 * Negative when `a` is below `b`. Mirrors `comparePlans` in the API's
 * `plan.service.ts`; a plan outside the billable three (ENTERPRISE, SUSPENDED)
 * is ranked below everything, so moving off it always reads as an upgrade and
 * goes to checkout — which is what a suspended account needs.
 */
export function comparePlans(a: string, b: string): number {
  return (PLAN_RANK[a as BillablePlan] ?? -1) - (PLAN_RANK[b as BillablePlan] ?? -1);
}

/**
 * POST /billing/checkout — initialises a Paystack transaction for the requested plan.
 * The returned authorizationUrl is where the browser should navigate to complete payment.
 */
export function useCheckout(): UseMutationResult<CheckoutResponse, Error, BillablePlan> {
  return useMutation({
    mutationFn: (plan: BillablePlan) =>
      apiFetch<CheckoutResponse>('/billing/checkout', {
        method: 'POST',
        body: { plan },
      }),
  });
}

/** How far into the trial the business is, and therefore what to say about it. */
export type TrialStage = 'none' | 'prompt' | 'final_day' | 'ended' | 'lapsed';

export interface BillingLimit {
  used: number;
  /** Null means the plan sets no ceiling — never zero. */
  limit: number | null;
  remaining: number | null;
  nearLimit: boolean;
  overLimit: boolean;
}

export interface UsageWarning {
  resource: 'conversations' | 'orders' | 'staff' | 'products';
  level: 'near' | 'over';
  used: number;
  limit: number;
  /** True when reaching this limit actually stops something working. */
  blocking: boolean;
  message: string;
}

export interface ScheduledChange {
  kind: 'downgrade' | 'cancel' | 'pause';
  targetPlan: string;
  previousPlan: string;
  effectiveAt: string;
  /** True when Paystack could not queue the replacement and the owner must pay by hand. */
  requiresCheckout: boolean;
  appliedAt: string | null;
}

export interface BillingState {
  plan: string;
  /** What is being enforced right now — differs from `plan` once a trial lapses. */
  effectivePlan: string;
  planLabel: string;
  suspended: boolean;
  suspendReason: string | null;
  trial: {
    active: boolean;
    stage: TrialStage;
    daysRemaining: number | null;
    endsAt: string | null;
    graceEndsAt: string | null;
  };
  subscription: { code: string; amountMinor: number | null } | null;
  scheduledChange: ScheduledChange | null;
  usage: {
    periodEndsAt: string | null;
    conversations: BillingLimit;
    orders: BillingLimit;
    staff: BillingLimit;
    products: BillingLimit;
  };
  warnings: UsageWarning[];
}

export const BILLING_STATE_KEY = ['billing', 'state'] as const;

/**
 * Plan, trial countdown, usage and warnings, in one read.
 *
 * Nothing called this before, which is why the trial countdown, the 90% warning
 * and the over-limit prompt were all computed on the server every request and
 * then thrown away. It is read on the dashboard as well as in Settings, so it is
 * cached for a minute: none of these figures move faster than that, and the
 * dashboard already has six requests to make on a 3G connection.
 */
export function useBillingState(): UseQueryResult<BillingState, Error> {
  return useQuery({
    queryKey: BILLING_STATE_KEY,
    queryFn: () => apiFetch<BillingState>('/billing/state'),
    staleTime: 60_000,
  });
}

/** Something the business is already over on the plan it is moving down to. */
export interface DowngradeConflict {
  resource: 'conversations' | 'orders' | 'staff' | 'products';
  used: number;
  limitAfter: number;
  blocking: boolean;
  message: string;
}

export interface DowngradeResult {
  scheduled: boolean;
  requiresConfirmation: boolean;
  kind: 'downgrade';
  currentPlan: string;
  targetPlan: string;
  effectiveAt: string;
  requiresCheckout: boolean;
  conflicts: DowngradeConflict[];
  message: string;
}

/**
 * Moves to a cheaper plan at the end of the period already paid for.
 *
 * Two calls by design. Without `confirm` the server returns a preview — what
 * would be over the line, and the date it happens — and changes nothing, so the
 * owner sees the consequences before anything is committed. With `confirm: true`
 * it schedules. Both come back on the same shape, distinguished by `scheduled`.
 */
export function useDowngrade(): UseMutationResult<
  DowngradeResult,
  Error,
  { plan: BillablePlan; confirm?: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ plan, confirm }: { plan: BillablePlan; confirm?: boolean }) =>
      apiFetch<DowngradeResult>('/billing/downgrade', {
        method: 'POST',
        body: { plan, ...(confirm ? { confirm: true } : {}) },
      }),
    onSuccess: (result) => {
      // A preview committed nothing, so re-reading state would only cost the
      // owner a request on a metered connection.
      if (result.scheduled) {
        qc.invalidateQueries({ queryKey: BILLING_STATE_KEY });
        qc.invalidateQueries({ queryKey: ['business'] });
      }
    },
  });
}

export interface EndSubscriptionResult {
  scheduled: boolean;
  kind: 'cancel' | 'pause';
  currentPlan: string;
  /** Everything keeps working until this date — neither call cuts access today. */
  accessUntil: string;
  effectiveAt: string;
  resumable: boolean;
  message: string;
}

/**
 * Stops the subscription renewing, or pauses it.
 *
 * Mechanically the same call — Paystack has no pause — but pausing records the
 * plan being left, so resuming can offer it straight back. Neither takes effect
 * today: the plan runs to the end of the period already paid for.
 */
export function useEndSubscription(
  kind: 'cancel' | 'pause',
): UseMutationResult<EndSubscriptionResult, Error, { reason?: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reason }: { reason?: string }) =>
      apiFetch<EndSubscriptionResult>(`/billing/${kind}`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BILLING_STATE_KEY });
      qc.invalidateQueries({ queryKey: ['business'] });
    },
  });
}

export interface ResumeResult {
  resumed: boolean;
  /** True once the period has closed: there is nothing left to re-enable. */
  requiresCheckout: boolean;
  plan: string;
  message: string;
}

/** Reverses a pause, cancellation or downgrade that has not taken effect yet. */
export function useResumeSubscription(): UseMutationResult<ResumeResult, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ResumeResult>('/billing/resume', { method: 'POST', body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BILLING_STATE_KEY });
      qc.invalidateQueries({ queryKey: ['business'] });
    },
  });
}
