/**
 * The single HTTP client for the dashboard.
 *
 * Every hook routes through here so that authentication, token refresh and
 * error shape are handled once. Previously each hook carried its own copy of
 * `fetchJson`, none of which refreshed the access token — since access tokens
 * live for 15 minutes, users were silently signed out mid-session.
 */

const API_BASE = '/api/v1';

/**
 * The access token is held in memory only — never in `localStorage`.
 *
 * It lives 15 minutes, and the long-lived refresh token now sits in an
 * httpOnly cookie the browser sends automatically to `/auth/*`. Nothing
 * durable is reachable from JavaScript, so an XSS can at worst use the current
 * tab's short-lived token rather than walking away with 30 days of access.
 *
 * The cost is that a page reload starts with no token; `restoreSession()`
 * exchanges the cookie for a fresh one during app start-up.
 */
let accessToken: string | null = null;

/** Marks that a session probably exists, so start-up knows to try a refresh. */
const SESSION_HINT_KEY = 'flowdesk.session';

/**
 * Error carrying the API's machine-readable code alongside the message, so
 * callers can branch on the cause rather than string-matching.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  meta?: Record<string, unknown>;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Records the access token from a sign-in or refresh response. */
export function storeTokens(tokens: { accessToken: string }): void {
  accessToken = tokens.accessToken;
  // Not a credential — just a flag telling start-up a refresh is worth trying.
  localStorage.setItem(SESSION_HINT_KEY, '1');
}

export function clearTokens(): void {
  accessToken = null;
  localStorage.removeItem(SESSION_HINT_KEY);
  // Clear credentials left by the previous localStorage-based scheme.
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function isAuthenticated(): boolean {
  return accessToken !== null;
}

/** True when a previous session may still be resumable from the cookie. */
export function hasSessionHint(): boolean {
  return localStorage.getItem(SESSION_HINT_KEY) === '1';
}

/**
 * Re-establishes the session on page load by exchanging the httpOnly refresh
 * cookie for a new access token. Resolves false when there is no valid session.
 */
export async function restoreSession(): Promise<boolean> {
  if (!hasSessionHint()) return false;
  return ensureRefresh();
}

/**
 * In-flight refresh, shared by every caller.
 *
 * Without this, a page that fires several queries at once would send several
 * refresh requests; because refresh tokens rotate, all but the first would be
 * rejected and the user would be signed out.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Sends the httpOnly refresh cookie. No token in the body: the browser
      // cannot read it, which is the entire point.
      credentials: 'same-origin',
      body: '{}',
    });

    if (!response.ok) {
      clearTokens();
      return false;
    }

    const payload = (await response.json()) as ApiEnvelope<{ accessToken: string }>;

    if (!payload.data?.accessToken) {
      clearTokens();
      return false;
    }

    storeTokens(payload.data);
    return true;
  } catch {
    // A network failure is not proof the session is invalid, so the in-memory
    // token is kept and the caller simply sees the request fail.
    return false;
  }
}

function ensureRefresh(): Promise<boolean> {
  refreshInFlight ??= refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Sends the user to sign-in after an unrecoverable auth failure. */
function redirectToLogin(): void {
  clearTokens();
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skips the auth header and the refresh retry — used by sign-in itself. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token && !options.anonymous) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };

  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  return fetch(`${API_BASE}${path}`, init);
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: ApiEnvelope<T>;

  try {
    payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : { success: response.ok };
  } catch {
    throw new ApiError(
      `Unexpected response from the server (${response.status})`,
      response.status,
      'BAD_RESPONSE',
    );
  }

  if (!response.ok || payload.success === false) {
    throw new ApiError(
      payload.error ?? `Request failed (${response.status})`,
      response.status,
      payload.code ?? 'REQUEST_FAILED',
    );
  }

  return payload.data as T;
}

/**
 * Performs an authenticated API request, transparently refreshing the access
 * token once if the server reports it has expired.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options, getAccessToken());

  if (response.status === 401 && !options.anonymous) {
    const refreshed = await ensureRefresh();

    if (!refreshed) {
      redirectToLogin();
      throw new ApiError('Your session has expired. Please sign in again.', 401, 'UNAUTHORIZED');
    }

    response = await send(path, options, getAccessToken());

    if (response.status === 401) {
      redirectToLogin();
    }
  }

  return parse<T>(response);
}

/** Builds a query string, omitting empty values so filters stay clean. */
export function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

interface TokenClaims {
  businessId: string;
  staffId?: string;
  role?: 'MANAGER' | 'OPERATIONS' | 'DELIVERY';
  plan?: string;
  exp?: number;
}

/**
 * Reads the (unverified) claims from the access token.
 *
 * Used only to tailor the UI. The server re-validates every request, so a
 * tampered token changes what is displayed, never what is permitted.
 */
export function decodeToken(): TokenClaims | null {
  const token = getAccessToken();
  if (!token) return null;

  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return null;
  }
}
