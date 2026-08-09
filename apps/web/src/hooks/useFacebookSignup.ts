import { useEffect, useMemo, useRef, useCallback, useState } from 'react';

export interface WhatsAppConfig {
  appId: string;
  configId: string | null;
  apiVersion: string;
  embeddedSignupEnabled: boolean;
  environment?: 'development' | 'test' | 'production';
}

export interface EmbeddedSignupResult {
  code: string;
  phoneNumberId: string;
  wabaId?: string;
}

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

interface FacebookSdk {
  init(params: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(
    callback: (response: FbLoginResponse) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const POPUP_TIMEOUT_MS = 60_000;

function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      resolve(window.FB);
      return;
    }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      if (window.FB) resolve(window.FB);
      else reject(new Error('Facebook SDK failed to initialize'));
    };
    const existing = document.getElementById('facebook-jssdk');
    if (existing) return;
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('Failed to load Facebook SDK'));
    document.body.appendChild(script);
  });
}

/**
 * Guards against the loading spinner getting stuck when the Facebook SDK popup
 * is blocked or closed without firing the login callback (e.g. Meta's
 * "can't onboard" error). Resets loading when the window regains focus after a
 * short delay, and via a hard timeout as a last resort.
 */
function useLoadingSafety(
  setIsLoading: (value: boolean) => void,
  onError?: (message: string) => void,
): {
  start: () => void;
  finish: () => void;
} {
  const pendingRef = useRef(false);
  const startTimeRef = useRef(0);

  useEffect(() => {
    function onFocus(): void {
      if (!pendingRef.current) return;
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed < 3_000) return;
      pendingRef.current = false;
      setIsLoading(false);
      onError?.('The Facebook dialog closed without completing the request.');
    }

    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [setIsLoading, onError]);

  const start = useCallback(() => {
    pendingRef.current = true;
    startTimeRef.current = Date.now();
    window.setTimeout(() => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      setIsLoading(false);
      onError?.('The Facebook dialog timed out. Please try again.');
    }, POPUP_TIMEOUT_MS);
  }, [setIsLoading, onError]);

  const finish = useCallback(() => {
    pendingRef.current = false;
    setIsLoading(false);
  }, [setIsLoading]);

  // Memoised as an object: `launch` lists this in its dependency array, so a
  // fresh literal every render would give `launch` a new identity every render
  // and defeat its own memoisation.
  return useMemo(() => ({ start, finish }), [start, finish]);
}

interface UseFacebookSignupOptions {
  config: WhatsAppConfig | undefined;
  onSuccess: (result: EmbeddedSignupResult) => void;
  onError?: (message: string) => void;
}

export interface UseFacebookSignupReturn {
  launch: () => Promise<void>;
  isLoading: boolean;
}

export function useFacebookSignup({ config, onSuccess, onError }: UseFacebookSignupOptions): UseFacebookSignupReturn {
  const [isLoading, setIsLoading] = useState(false);
  const signupInfo = useRef<{ phoneNumberId?: string; wabaId?: string }>({});
  const safety = useLoadingSafety(setIsLoading, onError);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (!event.origin.endsWith('facebook.com')) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type === 'WA_EMBEDDED_SIGNUP' && data?.data) {
          signupInfo.current = {
            phoneNumberId: data.data.phone_number_id,
            wabaId: data.data.waba_id,
          };
        }
      } catch {
        // Non-JSON messages from the SDK are expected; ignore them.
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const launch = useCallback(async () => {
    setIsLoading(true);
    // Cleared before each attempt. Meta does not always re-post the selection
    // event on a retry, so a leftover phone number from an abandoned attempt
    // would otherwise be used to connect the wrong WhatsApp number.
    signupInfo.current = {};
    safety.start();
    try {
      if (!config?.appId || !config.configId) {
        throw new Error('Embedded Signup is not configured.');
      }
      const fb = await loadFacebookSdk(config.appId, config.apiVersion);
      fb.login(
        (response) => {
          safety.finish();
          const code = response.authResponse?.code;
          const phoneNumberId = signupInfo.current.phoneNumberId;
          if (!code || !phoneNumberId) {
            onError?.('Connection was cancelled or no number was selected.');
            return;
          }
          onSuccess({
            code,
            phoneNumberId,
            ...(signupInfo.current.wabaId ? { wabaId: signupInfo.current.wabaId } : {}),
          });
        },
        {
          config_id: config.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
        },
      );
    } catch (error: unknown) {
      safety.finish();
      onError?.(error instanceof Error ? error.message : 'Failed to start Embedded Signup');
    }
  }, [config, onSuccess, onError, safety]);

  return { launch, isLoading };
}

interface UseFacebookLoginOptions {
  appId: string | undefined;
  apiVersion: string | undefined;
  onSuccess: (code: string) => void;
  onError?: (message: string) => void;
}

export interface UseFacebookLoginReturn {
  launch: () => Promise<void>;
  isLoading: boolean;
}

export function useFacebookLogin({ appId, apiVersion, onSuccess, onError }: UseFacebookLoginOptions): UseFacebookLoginReturn {
  const [isLoading, setIsLoading] = useState(false);
  const safety = useLoadingSafety(setIsLoading, onError);

  const launch = useCallback(async () => {
    setIsLoading(true);
    safety.start();
    try {
      if (!appId || !apiVersion) {
        throw new Error('Facebook Login is not configured.');
      }
      const fb = await loadFacebookSdk(appId, apiVersion);
      fb.login(
        (response) => {
          safety.finish();
          const code = response.authResponse?.code;
          if (!code) {
            onError?.('Login was cancelled.');
            return;
          }
          onSuccess(code);
        },
        {
          response_type: 'code',
          override_default_response_type: true,
          extras: { sessionInfoVersion: '3' },
        },
      );
    } catch (error: unknown) {
      safety.finish();
      onError?.(error instanceof Error ? error.message : 'Failed to start Facebook Login');
    }
  }, [appId, apiVersion, onSuccess, onError, safety]);

  return { launch, isLoading };
}
