import { useState } from 'react';
import { MessageSquare, ShieldCheck, Loader2, Plug, Unplug, AlertCircle } from 'lucide-react';
import {
  useWhatsAppConfig,
  useWhatsAppStatus,
  useConnectWhatsApp,
  useConnectWhatsAppManual,
  useDisconnectWhatsApp,
} from '@/hooks/useWhatsApp';
import { useFacebookSignup } from '@/hooks/useFacebookSignup';

export default function WhatsAppConnection(): React.JSX.Element {
  const { data: config } = useWhatsAppConfig();
  const { data: status, isLoading } = useWhatsAppStatus();
  const connect = useConnectWhatsApp();
  const connectManual = useConnectWhatsAppManual();
  const disconnect = useDisconnectWhatsApp();

  const [showManual, setShowManual] = useState(false);
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

  const handleManualConnect = (): void => {
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
  };

  const connected = status?.connected ?? false;
  const busy = connect.isPending || connectManual.isPending || disconnect.isPending || launching;
  const errorMessage =
    sdkError ??
    (connect.error as Error | null)?.message ??
    (connectManual.error as Error | null)?.message ??
    null;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
        <MessageSquare className="h-4 w-4" /> WhatsApp Connection
      </h2>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking connection…
        </div>
      ) : connected ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
            <ShieldCheck className="h-4 w-4" />
            Connected{status?.waPhoneNumberId ? ` (number id: ${status.waPhoneNumberId})` : ''}
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Your customers' messages route to this dashboard and replies are sent from your own number.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm('Disconnect this WhatsApp number? Auto-replies will stop until you reconnect.')) {
                disconnect.mutate();
              }
            }}
            className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-muted)] disabled:opacity-50"
          >
            {disconnect.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unplug className="h-3 w-3" />}
            Disconnect
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Connect your WhatsApp Business number to receive messages and send auto-replies from your own number.
          </p>

          {config?.embeddedSignupEnabled ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void launchEmbeddedSignup()}
              className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-light)] disabled:opacity-50"
            >
              {connect.isPending || launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              Connect with WhatsApp
            </button>
          ) : (
            <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--color-warning-muted)] px-3 py-2 text-xs text-[var(--color-warning)]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Embedded Signup isn't configured on the server (META_CONFIG_ID). Use manual connection below.
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="w-fit text-xs font-medium text-[var(--color-text-muted)] underline-offset-2 hover:underline"
          >
            {showManual ? 'Hide manual connection' : 'Connect manually (advanced)'}
          </button>

          {showManual && (
            <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                Phone number ID
                <input
                  value={manualPhoneId}
                  onChange={(e) => setManualPhoneId(e.target.value)}
                  placeholder="e.g. 1130154836849896"
                  className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
                />
              </label>
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                Access token
                <input
                  type="password"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="System user access token"
                  className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
                />
              </label>
              <button
                type="button"
                disabled={busy || !manualPhoneId.trim() || !manualToken.trim()}
                onClick={handleManualConnect}
                className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-light)] disabled:opacity-50"
              >
                {connectManual.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
                Connect
              </button>
            </div>
          )}
        </div>
      )}

      {errorMessage && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--color-danger)]">
          <AlertCircle className="h-3.5 w-3.5" /> {errorMessage}
        </p>
      )}
    </div>
  );
}
