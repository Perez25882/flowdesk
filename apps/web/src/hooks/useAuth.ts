import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { hasCapability, type Capability, type StaffRole } from '@flowdesk/shared';
import {
  apiFetch,
  clearTokens,
  decodeToken,
  getAccessToken,
  isAuthenticated as hasToken,
  storeTokens,
} from '@/lib/api';
import { disconnect as disconnectRealtime, reconnect as reconnectRealtime } from '@/hooks/useSSE';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthenticatedBusiness {
  id: string;
  name: string;
  ownerName: string;
  email: string | null;
  plan: string;
  trialEndsAt: string | null;
  waConnected: boolean;
}

export interface AuthResult extends AuthTokens {
  business: AuthenticatedBusiness;
}

export interface RegisterPayload {
  businessName: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface StaffLoginPayload {
  phone: string;
  password: string;
}

function useAuthMutation<TPayload>(
  path: string,
): UseMutationResult<AuthResult, Error, TPayload, unknown> {
  const queryClient = useQueryClient();

  return useMutation<AuthResult, Error, TPayload, unknown>({
    mutationFn: (payload: TPayload) =>
      apiFetch<AuthResult>(path, { method: 'POST', body: payload, anonymous: true }),
    onSuccess: (data) => {
      storeTokens(data);
      // Drop any cache belonging to a previously signed-in account.
      queryClient.clear();
      // Open a stream for the new session. Signing in is a client-side
      // navigation, so any socket from a previous account on this device is
      // still open and authenticated as that account until it is replaced.
      reconnectRealtime();
    },
  });
}

export function useRegister(): UseMutationResult<AuthResult, Error, RegisterPayload, unknown> {
  return useAuthMutation<RegisterPayload>('/auth/register');
}

export function useLogin(): UseMutationResult<AuthResult, Error, LoginPayload, unknown> {
  return useAuthMutation<LoginPayload>('/auth/login');
}

export function useStaffLogin(): UseMutationResult<AuthResult, Error, StaffLoginPayload, unknown> {
  return useAuthMutation<StaffLoginPayload>('/staff/login');
}

export function useForgotPassword(): UseMutationResult<
  { message: string; resetToken?: string },
  Error,
  { email: string },
  unknown
> {
  return useMutation({
    mutationFn: (payload: { email: string }) =>
      apiFetch<{ message: string; resetToken?: string }>('/auth/forgot-password', {
        method: 'POST',
        body: payload,
        anonymous: true,
      }),
  });
}

export function useResetPassword(): UseMutationResult<
  { message: string },
  Error,
  { token: string; password: string },
  unknown
> {
  return useMutation({
    mutationFn: (payload: { token: string; password: string }) =>
      apiFetch<{ message: string }>('/auth/reset-password', {
        method: 'POST',
        body: payload,
        anonymous: true,
      }),
  });
}

export function useAcceptStaffInvite(): UseMutationResult<
  unknown,
  Error,
  { token: string; password: string },
  unknown
> {
  return useMutation({
    mutationFn: (payload: { token: string; password: string }) =>
      apiFetch('/staff/accept', { method: 'POST', body: payload, anonymous: true }),
  });
}

export function useChangePassword(): UseMutationResult<
  { message: string },
  Error,
  { currentPassword: string; newPassword: string },
  unknown
> {
  return useMutation({
    mutationFn: (payload: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ message: string }>('/auth/change-password', { method: 'POST', body: payload }),
  });
}

export function useLogout(): UseMutationResult<void, Error, void, unknown> {
  const queryClient = useQueryClient();

  return useMutation<void, Error, void, unknown>({
    mutationFn: async () => {
      // The refresh token travels in the httpOnly cookie, so nothing is sent
      // in the body. A failed sign-out on the server must not trap the user in
      // the app, hence the catch.
      await apiFetch('/auth/logout', {
        method: 'POST',
        body: {},
        anonymous: true,
      }).catch(() => undefined);
    },
    onSettled: () => {
      // Close the stream before the token goes: it outlives this component
      // otherwise, holding the signed-out account's credentials open.
      disconnectRealtime();
      clearTokens();
      queryClient.clear();
    },
  });
}

export { getAccessToken, decodeToken };

export function isAuthenticated(): boolean {
  return hasToken();
}

export function getUserRole(): string | null {
  return decodeToken()?.role ?? null;
}

/** The owner is the account holder, staff tokens carry a staffId, owners do not. */
export function isOwner(): boolean {
  const claims = decodeToken();
  return claims !== null && !claims.staffId;
}

export function isManager(): boolean {
  return getUserRole() === 'MANAGER';
}

export function isOperationsStaff(): boolean {
  return getUserRole() === 'OPERATIONS';
}

export function isDeliveryStaff(): boolean {
  return getUserRole() === 'DELIVERY';
}

/**
 * Whether the signed-in caller holds a capability.
 *
 * Reads the same matrix the API enforces (`@flowdesk/shared`), so a control is
 * hidden exactly when the endpoint behind it would return 403. This is a
 * rendering decision only, the server check is the real one.
 */
export function can(capability: Capability): boolean {
  if (isOwner()) return true;
  return hasCapability((getUserRole() as StaffRole | null) ?? undefined, capability);
}

/** Financial figures are visible to the owner and managers only. */
export function canAccessRevenue(): boolean {
  return can('revenue.read');
}

export function canAccessStaffManagement(): boolean {
  return can('staff.manage');
}

/** Billing and plan changes are the account holder's alone. */
export function canAccessBilling(): boolean {
  return isOwner();
}
