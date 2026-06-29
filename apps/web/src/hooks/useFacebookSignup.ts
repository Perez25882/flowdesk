import { useEffect, useRef, useCallback, useState } from 'react';

export interface WhatsAppConfig {
  appId: string;
  configId: string | null;
  apiVersion: string;
  embeddedSignupEnabled: boolean;
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
    try {
      if (!config?.appId || !config.configId) {
        throw new Error('Embedded Signup is not configured.');
      }
      const fb = await loadFacebookSdk(config.appId, config.apiVersion);
      fb.login(
        (response) => {
          setIsLoading(false);
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
      setIsLoading(false);
      onError?.(error instanceof Error ? error.message : 'Failed to start Embedded Signup');
    }
  }, [config, onSuccess, onError]);

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

  const launch = useCallback(async () => {
    setIsLoading(true);
    try {
      if (!appId || !apiVersion) {
        throw new Error('Facebook Login is not configured.');
      }
      const fb = await loadFacebookSdk(appId, apiVersion);
      fb.login(
        (response) => {
          setIsLoading(false);
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
      setIsLoading(false);
      onError?.(error instanceof Error ? error.message : 'Failed to start Facebook Login');
    }
  }, [appId, apiVersion, onSuccess, onError]);

  return { launch, isLoading };
}
