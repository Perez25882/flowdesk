import { useState } from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import {
  useWhatsAppConfig,
  useWhatsAppStatus,
  useConnectWhatsApp,
  useConnectWhatsAppManual,
  useDisconnectWhatsApp,
} from '@/hooks/useWhatsApp';
import { useFacebookSignup } from '@/hooks/useFacebookSignup';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The one setting that matters.
 *
 * Disconnecting used to go through `window.confirm`, which cannot be styled,
 * cannot be read properly by some screen readers, and on mobile Chrome renders
 * as a system dialog that many people dismiss reflexively. It is now an inline
 * confirmation that states the actual consequence.
 */
export default function WhatsAppConnection(): React.JSX.Element {
  const { data: config } = useWhatsAppConfig();
  const { data: status, isLoading } = useWhatsAppStatus();
  const connect = useConnectWhatsApp();
  const connectManual = useConnectWhatsAppManual();
  const disconnect = useDisconnectWhatsApp();

  const [showManual, setShowManual] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [manualPhoneId, setManualPhoneId] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [sdkError, setSdkError] = useState<string | null>(null);

  const { launch: launchEmbeddedSignup, isLoading: launching } = useFacebookSignup({
    config,
    onSuccess: (result) => {
      connect.mutate({
        code: result.code,
        phoneNumberId: result.phoneNumberId,
        ...(result.wabaId ? { wabaId: result.wabaId } : {}),
      });
    },
    onError: (message) => setSdkError(message),
  });

  function handleManualConnect(): void {
    if (!manualPhoneId.trim() || !manualToken.trim()) return;
    connectManual.mutate(
      { phoneNumberId: manualPhoneId.trim(), accessToken: manualToken.trim() },
      {
        onSuccess: () => {
          setManualPhoneId('');
          setManualToken('');
          setShowManual(false);
        },
      },
    );
  }

  const connected = status?.connected ?? false;
  const busy = connect.isPending || connectManual.isPending || disconnect.isPending || launching;
  const errorMessage =
    sdkError ??
    (connect.error as Error | null)?.message ??
    (connectManual.error as Error | null)?.message ??
    null;

  return (
    <Panel>
      <PanelHead
        title="WhatsApp connection"
        action={
          connected ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Connected
            </span>
          ) : undefined
        }
      />

      <div className="p-4">
        {isLoading ? (
          <div className="flex flex-col gap-2" role="status" aria-busy="true">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
            <span className="sr-only">Checking your WhatsApp connection</span>
          </div>
        ) : connected ? (
          <div className="flex flex-col gap-4">
            <div>
              <p className="max-w-prose text-sm text-text-secondary">
                Messages arrive here. Replies go out from your own number.
              </p>
              {status?.waPhoneNumberId && (
                <p className="fd-figure mt-2 text-xs text-text-muted">
                  Number ID {status.waPhoneNumberId}
                </p>
              )}
            </div>

            {confirmingDisconnect ? (
              <div className="rounded-md border border-danger-border bg-danger-muted p-3">
                <p className="max-w-prose text-sm font-medium text-text-primary">
                  Disconnect this number?
                </p>
                <p className="mt-1 max-w-prose text-sm text-text-secondary">
                  Orders stop arriving and replies stop going out. Your records are untouched.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      disconnect.mutate();
                      setConfirmingDisconnect(false);
                    }}
                    isLoading={disconnect.isPending}
                  >
                    Yes, disconnect
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(false)}>
                    Keep it connected
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                className="w-fit text-danger"
                disabled={busy}
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="max-w-prose text-sm text-text-secondary">
              Connect the number you already give customers. Nothing works until you do.
            </p>

            {config?.embeddedSignupEnabled ? (
              <Button
                className="w-fit"
                disabled={busy}
                isLoading={connect.isPending || launching}
                onClick={() => void launchEmbeddedSignup()}
              >
                Connect WhatsApp
              </Button>
            ) : (
              <p className="flex max-w-prose items-start gap-2 rounded-md border border-warning-border bg-warning-muted px-3 py-2.5 text-sm text-text-secondary">
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span>
                  One-click connection is not set up on this server. Use the manual option below, or
                  ask whoever deployed Flowdesk to configure <code className="fd-figure">META_CONFIG_ID</code>.
                </span>
              </p>
            )}

            <div>
              <button
                type="button"
                onClick={() => setShowManual((v) => !v)}
                aria-expanded={showManual}
                aria-controls="whatsapp-manual-setup"
                className="w-fit rounded-sm text-sm text-text-secondary underline decoration-border-strong underline-offset-[3px] transition-colors duration-fast ease-out hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {showManual ? 'Hide manual setup' : 'Connect manually instead'}
              </button>

              {showManual && (
                <div
                  id="whatsapp-manual-setup"
                  className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3"
                >
                  <p className="max-w-prose text-xs text-text-muted">
                    For businesses with an existing Meta Business Manager app. Otherwise use the button above.
                  </p>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-text-primary">Phone number ID</span>
                    <input
                      value={manualPhoneId}
                      onChange={(e) => setManualPhoneId(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="1130154836849896"
                      className="fd-input fd-input-compact h-11 py-0 font-mono sm:h-10"
                    />
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-text-primary">Access token</span>
                    <input
                      type="password"
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="System user access token"
                      className="fd-input fd-input-compact h-11 py-0 font-mono sm:h-10"
                    />
                  </label>

                  <Button
                    size="sm"
                    className="w-fit"
                    disabled={busy || !manualPhoneId.trim() || !manualToken.trim()}
                    isLoading={connectManual.isPending}
                    onClick={handleManualConnect}
                  >
                    Connect
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {errorMessage && (
          <p
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-md border border-danger-border bg-danger-muted px-3 py-2.5 text-sm font-medium text-danger"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            {errorMessage}
          </p>
        )}
      </div>
    </Panel>
  );
}
