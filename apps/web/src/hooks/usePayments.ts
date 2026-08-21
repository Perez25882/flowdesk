import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import type { PaymentConfidence, PaymentDirection } from '@flowdesk/shared';
import { apiFetch, apiFetchBlob } from '@/lib/api';



export interface Payment {
  id: string;
  amount: number;
  method: string;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  reference: string | null;
  attestedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  screenshotUrl: string | null;
  customer: { id: string; name: string | null; waNumber: string };
  orderId: string | null;
  createdAt: string;
}

export interface CreatePaymentInput {
  customerId: string;
  orderId?: string;
  amount: number;
  method: string;
  /** Omit for a normal receipt. 'OUT' records a refund. */
  direction?: PaymentDirection;
  reference?: string;
  notes?: string;
}

export function usePayments(attested?: boolean, hasScreenshot?: boolean): UseQueryResult<Payment[], Error> {
  const params = new URLSearchParams();
  if (attested !== undefined) params.set('attested', String(attested));
  if (hasScreenshot) params.set('hasScreenshot', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['payments', attested, hasScreenshot],
    queryFn: () => apiFetch<Payment[]>(`/payments${query}`),
    staleTime: 30_000,
  });
}

export function useCreatePayment(): UseMutationResult<Payment, Error, CreatePaymentInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePaymentInput) =>
      apiFetch<Payment>('/payments', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useAttestPayment(): UseMutationResult<Payment, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Payment>(`/payments/${id}/attest`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

/**
 * Reverses a payment without deleting it. The reason is required by the API —
 * an unexplained reversal is not evidence of anything.
 */
export function useVoidPayment(): UseMutationResult<void, Error, { id: string; reason: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<void>(`/payments/${id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

/**
 * One thing waiting to be checked.
 *
 * `SCREENSHOT` is a MoMo receipt image the customer sent; `LOGGED` is an amount
 * a staff member wrote down but is not allowed to attest to themselves. Both ask
 * the owner the same question — did this money actually arrive — which is why
 * they share one queue.
 */
export interface ReviewQueueItem {
  paymentId: string;
  kind: 'SCREENSHOT' | 'LOGGED';
  /**
   * Null when nobody has read the figure off the image yet. It must render as a
   * dash and never as `0`: a zero here would read as "they paid nothing", when
   * what it means is "nobody has looked".
   */
  amount: number | null;
  method: string;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  reference: string | null;
  notes: string | null;
  createdAt: string;
  customer: { id: string; name: string | null; waNumber: string };
  order: {
    id: string;
    referenceNumber: string;
    totalAmount: number;
    amountPaid: number;
    outstanding: number;
  } | null;
  /** Null for a LOGGED claim — there is no image behind it. */
  screenshot: {
    available: boolean;
    /** Path relative to the API base, to be fetched with the auth header. */
    viewUrl: string | null;
    /** `NOT_ARCHIVED`: Meta's five-minute media link expired before we saved it. */
    unavailableReason: 'NOT_ARCHIVED' | null;
    caption: string | null;
    receivedAt: string | null;
    messageId: string | null;
  } | null;
}

export const REVIEW_QUEUE_KEY = ['payments', 'review-queue'] as const;

/**
 * Everything waiting on a person, newest first.
 *
 * The Payments page previously built this list from `?attested=false&hasScreenshot=true`,
 * which filtered on `screenshotUrl` — a column that is null for exactly the
 * screenshots that failed to archive, and null for every logged claim. The tab
 * was therefore permanently empty while claims piled up behind it.
 */
export function useReviewQueue(limit = 50): UseQueryResult<ReviewQueueItem[], Error> {
  return useQuery({
    queryKey: [...REVIEW_QUEUE_KEY, limit],
    queryFn: () => apiFetch<ReviewQueueItem[]>(`/payments/review-queue?limit=${limit}`),
    staleTime: 15_000,
  });
}

export interface ConfirmPaymentInput {
  amount: number;
  method: string;
  orderId?: string;
  reference?: string;
}

/**
 * Records what a person read off the screenshot and attests it in one write.
 *
 * The amount and the method carry no defaults on either side of the wire. A
 * screenshot claim is stored with a zero amount and a method of OTHER until
 * someone looks, and letting either of those be attested by omission would put
 * a placeholder into the revenue figures with a single tap.
 *
 * A 400 back means the claim was already confirmed or voided by somebody else —
 * two people at the same counter with the same queue open.
 */
export function useConfirmPayment(): UseMutationResult<
  Payment,
  Error,
  { id: string; data: ConfirmPaymentInput }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ConfirmPaymentInput }) =>
      apiFetch<Payment>(`/payments/${id}/confirm`, { method: 'PATCH', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export interface ScreenshotImage {
  /** An object URL, or null while loading or after a failure. */
  src: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Loads a payment screenshot as an object URL.
 *
 * `<img src="/api/v1/payments/…/screenshot">` cannot work here: the access token
 * is held in memory rather than in a cookie, so the browser's own image request
 * carries no Authorization header and comes back 401. The bytes are fetched
 * through the API client instead and wrapped in a Blob URL.
 *
 * The URL is revoked on unmount and whenever the path changes. Without that,
 * every screenshot the owner opens stays resident for the life of the tab —
 * which on the phone this is used from is a few hundred kilobytes each, in a
 * queue that can hold fifty.
 */
export function usePaymentScreenshot(path: string | null): ScreenshotImage {
  const [state, setState] = useState<ScreenshotImage>({
    src: null,
    isLoading: path !== null,
    error: null,
  });

  useEffect(() => {
    if (!path) {
      setState({ src: null, isLoading: false, error: null });
      return;
    }

    let objectUrl: string | null = null;
    // Set false by cleanup, so a response arriving after the drawer closed
    // neither writes state into an unmounted component nor leaks its URL.
    let live = true;

    setState({ src: null, isLoading: true, error: null });

    apiFetchBlob(path)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!live) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setState({ src: objectUrl, isLoading: false, error: null });
      })
      .catch((error: Error) => {
        if (!live) return;
        setState({ src: null, isLoading: false, error: error.message });
      });

    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}

export interface RevenueStats {
  totalRevenue: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  byMethod: Record<string, number>;
}

export function useRevenueStats(): UseQueryResult<RevenueStats, Error> {
  return useQuery({
    queryKey: ['payments', 'stats'],
    queryFn: () => apiFetch<RevenueStats>('/payments/stats'),
    staleTime: 60_000,
  });
}
