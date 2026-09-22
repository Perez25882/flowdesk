import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type AppointmentStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export interface Service {
  id: string;
  name: string;
  description?: string | null;
  aliases?: string[];
  durationMinutes: number;
  bufferMinutes: number;
  /** Chairs, rooms or practitioners, how many can run at once. */
  capacity: number;
  price: number | null;
  active?: boolean;
}

export interface Slot {
  /** ISO 8601. */
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  resourceIndex: number;
}

export interface SlotsResponse {
  service: Service;
  slots: Slot[];
  /**
   * Why the list is empty, when it is.
   *
   * `no_opening_hours` and `fully_booked` look identical to a customer and
   * mean completely different things to an owner, one is a diary problem and
   * the other is a settings problem they can fix in a minute.
   */
  reason: 'no_opening_hours' | 'fully_booked' | null;
}

export interface Appointment {
  id: string;
  reference: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  notes: string | null;
  resourceIndex: number;
  bookedByAssistant: boolean;
  service: { id: string; name: string; capacity: number };
  customer: { id: string; name: string | null; waNumber: string };
}

export function useServices(): UseQueryResult<Service[], Error> {
  return useQuery({
    queryKey: ['services'],
    queryFn: () => apiFetch<Service[]>('/services'),
    staleTime: 60_000,
  });
}

export function useSlots(
  serviceId: string | null,
  days = 14,
): UseQueryResult<SlotsResponse, Error> {
  return useQuery({
    queryKey: ['services', serviceId, 'slots', days],
    queryFn: () => apiFetch<SlotsResponse>(`/services/${serviceId}/slots?days=${days}`),
    enabled: Boolean(serviceId),
    // Short, because this is the one thing in the app that genuinely goes
    // stale while you are looking at it: another booking can take the slot
    // being offered on screen.
    staleTime: 15_000,
  });
}

export function useAppointments(
  from?: string,
  to?: string,
): UseQueryResult<Appointment[], Error> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();

  return useQuery({
    queryKey: ['appointments', from, to],
    queryFn: () => apiFetch<Appointment[]>(`/appointments${query ? `?${query}` : ''}`),
    staleTime: 30_000,
  });
}

export function useCreateService(): UseMutationResult<Service, Error, Partial<Service>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data) =>
      apiFetch<Service>('/services', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

export function useUpdateService(): UseMutationResult<
  Service,
  Error,
  { id: string; data: Partial<Service> }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }) =>
      apiFetch<Service>(`/services/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

export function useDeleteService(): UseMutationResult<{ id: string }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => apiFetch<{ id: string }>(`/services/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

export function useSetAppointmentStatus(): UseMutationResult<
  { id: string },
  Error,
  { id: string; status: AppointmentStatus; cancelReason?: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status, cancelReason }) =>
      apiFetch<{ id: string }>(`/appointments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(cancelReason ? { cancelReason } : {}) }),
      }),
    onSuccess: () => {
      // Both: cancelling frees a slot, so the availability the owner is
      // looking at is now wrong as well as the list.
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
      void queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}
