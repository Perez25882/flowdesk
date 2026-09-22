import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { apiFetch, apiFetchBlob } from '@/lib/api';
import type { Shipment } from '@/types/order';

/**
 * Dispatch, from the dashboard.
 *
 * Every mutation here also moves the order's status server-side, so each one
 * invalidates the whole `orders` tree rather than just the shipment: a
 * dispatched order leaves the Packing column and appears in On the way, and a
 * board that did not refresh would show it in both.
 */

export function useShipment(orderId: string | null): UseQueryResult<Shipment | null, Error> {
  return useQuery({
    queryKey: ['shipment', orderId],
    queryFn: async () => {
      const result = await apiFetch<{ shipment: Shipment | null }>(`/orders/${orderId}/shipment`);
      return result.shipment;
    },
    enabled: !!orderId,
    staleTime: 30_000,
  });
}

export interface DispatchInput {
  courier?: string;
  trackingNumber?: string;
  notes?: string;
}

function useShipmentMutation<TInput>(
  orderId: string,
  request: (input: TInput) => Promise<{ shipment: Shipment }>,
): UseMutationResult<Shipment, Error, TInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => (await request(input)).shipment,
    onSuccess: (shipment) => {
      qc.setQueryData(['shipment', orderId], shipment);
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useDispatchOrder(orderId: string): UseMutationResult<Shipment, Error, DispatchInput> {
  return useShipmentMutation<DispatchInput>(orderId, (body) =>
    apiFetch<{ shipment: Shipment }>(`/orders/${orderId}/dispatch`, { method: 'POST', body }),
  );
}

export function useUploadProof(orderId: string): UseMutationResult<Shipment, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (image: string) =>
      (
        await apiFetch<{ shipment: Shipment }>(`/orders/${orderId}/dispatch/proof`, {
          method: 'POST',
          body: { image },
        })
      ).shipment,
    onSuccess: (shipment) => {
      qc.setQueryData(['shipment', orderId], shipment);
      // The photo is fetched by its own request and cached by the browser under
      // a URL that does not change, so the old one has to be dropped by hand.
      qc.invalidateQueries({ queryKey: ['shipment', orderId, 'proof'] });
    },
  });
}

export function useMarkDelivered(orderId: string): UseMutationResult<Shipment, Error, void> {
  return useShipmentMutation<void>(orderId, () =>
    apiFetch<{ shipment: Shipment }>(`/orders/${orderId}/dispatch/delivered`, {
      method: 'POST',
      body: {},
    }),
  );
}

/**
 * The proof photo.
 *
 * Fetched as a blob through the authenticated client rather than pointed at
 * with an `<img src>`: the bucket is private and the endpoint is behind the
 * same capability check as the order, so a bare URL in the markup would simply
 * 401. The object URL is revoked by the component that renders it.
 */
export function useProofImage(
  orderId: string | null,
  enabled: boolean,
): UseQueryResult<string, Error> {
  return useQuery({
    queryKey: ['shipment', orderId, 'proof'],
    queryFn: async () => {
      const blob = await apiFetchBlob(`/orders/${orderId}/dispatch/proof`);
      return URL.createObjectURL(blob);
    },
    enabled: !!orderId && enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
