import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ExternalServiceError, ValidationError } from '../../utils/errors.js';

const GRAPH_BASE = 'https://graph.facebook.com';

export interface MetaUserInfo {
  id: string;
  name: string;
  email?: string | undefined;
}

export interface PhoneNumberInfo {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

/**
 * Exchanges a short-lived authorization code (from Embedded Signup or Facebook
 * Login) for a short-lived access token. The app secret stays server-side.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new ExternalServiceError(
      'WhatsApp signup is not configured on this server (META_APP_ID / META_APP_SECRET missing)',
    );
  }

  const url = new URL(`${GRAPH_BASE}/${env.META_API_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', env.META_APP_ID);
  url.searchParams.set('client_secret', env.META_APP_SECRET);
  url.searchParams.set('code', code);

  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, body }, 'Meta token exchange failed');
    throw new ExternalServiceError('Failed to exchange Meta authorization code');
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new ExternalServiceError('Meta token exchange returned no access token');
  }
  return data.access_token;
}

/**
 * Fetches the identity of the person who authorized the token. Requires the
 * token to have `public_profile` and `email` scopes.
 */
export async function fetchMetaUserInfo(accessToken: string): Promise<MetaUserInfo> {
  const url = new URL(`${GRAPH_BASE}/${env.META_API_VERSION}/me`);
  url.searchParams.set('fields', 'id,name,email');
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, body }, 'Meta /me request failed');
    throw new ExternalServiceError('Failed to fetch Meta user identity');
  }

  const data = (await response.json()) as { id?: string; name?: string; email?: string };
  if (!data.id || !data.name) {
    throw new ExternalServiceError('Meta /me response missing required identity fields');
  }

  return { id: data.id, name: data.name, email: data.email };
}

/**
 * Validates that the access token can read the given phone number id and
 * returns its metadata. This both confirms the connection works and gives us
 * the display number to show in the dashboard.
 */
export async function fetchPhoneNumberInfo(
  phoneNumberId: string,
  accessToken: string,
): Promise<PhoneNumberInfo> {
  const url = new URL(`${GRAPH_BASE}/${env.META_API_VERSION}/${phoneNumberId}`);
  url.searchParams.set('fields', 'display_phone_number,verified_name');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, body, phoneNumberId }, 'Phone number validation failed');
    throw new ValidationError('Could not verify the WhatsApp phone number with the provided credentials');
  }

  const data = (await response.json()) as {
    display_phone_number?: string;
    verified_name?: string;
  };

  return {
    displayPhoneNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
  };
}

/**
 * Discovers the WhatsApp Business Account IDs the access token is scoped to
 * by calling the debug_token endpoint. These IDs are needed to subscribe the
 * app to each WABA so webhooks are delivered.
 */
export async function fetchWabaIdsFromToken(accessToken: string): Promise<string[]> {
  try {
    const url = new URL(`${GRAPH_BASE}/${env.META_API_VERSION}/debug_token`);
    url.searchParams.set('input_token', accessToken);
    url.searchParams.set('access_token', `${env.META_APP_ID}|${env.META_APP_SECRET}`);

    const response = await fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      logger.warn({ status: response.status, body }, 'debug_token request failed');
      return [];
    }

    const data = (await response.json()) as {
      data?: {
        granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
      };
    };

    const targetIds = new Set<string>();
    for (const scope of data.data?.granular_scopes ?? []) {
      if (scope.scope === 'whatsapp_business_management' || scope.scope === 'whatsapp_business_messaging') {
        for (const id of scope.target_ids ?? []) {
          targetIds.add(id);
        }
      }
    }

    return Array.from(targetIds);
  } catch (error: unknown) {
    logger.warn({ error }, 'Failed to fetch WABA ids from token');
    return [];
  }
}

/**
 * Subscribes the app to the business's WABA so inbound webhooks are delivered.
 * Best-effort: logs but does not fail the connection if subscription errors,
 * since the number can still be subscribed manually in Meta.
 */
export async function subscribeWabaToApp(wabaId: string, accessToken: string): Promise<void> {
  try {
    const url = `${GRAPH_BASE}/${env.META_API_VERSION}/${wabaId}/subscribed_apps`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      logger.warn({ status: response.status, body, wabaId }, 'WABA app subscription returned non-OK');
    }
  } catch (error: unknown) {
    logger.warn({ error, wabaId }, 'WABA app subscription failed (non-fatal)');
  }
}
