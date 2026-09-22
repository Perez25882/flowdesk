import { useEffect, useState } from 'react';
import { BadgeCheck, Loader2, Wallet } from 'lucide-react';
import {
  useConnectPayout,
  usePayoutStatus,
  useSettlementDestinations,
} from '@/hooks/usePayments';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHead } from '@/components/ui/Panel';

/**
 * Where the shop's money lands.
 *
 * The shortest screen in Settings on purpose: a network, a number, and the name
 * read back. Everything a payment gateway normally asks a merchant for , 
 * registration documents, a business bank account, a compliance review, is
 * carried by Flowdesk's own Paystack account, and the shop supplies the one
 * thing only they know. A setup that asked for more would not get finished, and
 * a shop that cannot take payment has no reason to keep the rest of the
 * product.
 */
export default function PayoutSettings(): React.JSX.Element {
  const { data: status, isLoading } = usePayoutStatus();
  const { data: destinations, isLoading: destinationsLoading } = useSettlementDestinations(
    status?.available ?? false,
  );
  const connect = useConnectPayout();

  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [editing, setEditing] = useState(false);

  // Pre-select what they are already settled to, so "change my momo number"
  // does not start by making them find their own network in a list again.
  useEffect(() => {
    if (status?.bankCode) setBankCode(status.bankCode);
  }, [status?.bankCode]);

  const canSave = bankCode.length > 0 && accountNumber.replace(/\s/g, '').length >= 6;
  const showForm = editing || !status?.connected;

  if (isLoading) {
    return (
      <Panel>
        <PanelHead title="Payouts" />
        <div className="h-24 animate-pulse bg-surface-hover" />
      </Panel>
    );
  }

  if (!status?.available) {
    return (
      <Panel>
        <PanelHead title="Payouts" />
        <p className="p-4 text-sm text-text-muted">
          Card and mobile money payments are not switched on for this deployment yet.
        </p>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead title="Payouts" meta="Where your payment links send the money" />

      <div className="flex flex-col gap-4 p-4">
        {status.connected && (
          <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-hover p-3">
            <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" strokeWidth={2} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">
                {status.accountName ?? 'Connected'}
              </p>
              <p className="text-xs text-text-muted">
                {status.bankName ?? 'Settlement account'} ·{' '}
                <span className="fd-figure">{status.accountNumber}</span>
              </p>
            </div>
            {!editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Change
              </Button>
            )}
          </div>
        )}

        {showForm && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">Network or bank</span>
              <select
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
                disabled={destinationsLoading}
                className="fd-input fd-input-compact h-11 py-0 sm:h-10"
              >
                <option value="">
                  {destinationsLoading ? 'Loading…' : 'Pick where you want to be paid'}
                </option>
                {(destinations ?? []).map((destination) => (
                  <option key={destination.code} value={destination.code}>
                    {destination.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">
                Momo number or account number
              </span>
              <input
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="024 123 4567"
                className="fd-input fd-input-compact h-11 py-0 sm:h-10"
              />
              <span className="text-xs text-text-muted">
                We check the name on it before saving, so a wrong digit is caught now rather
                than after the first payout.
              </span>
            </label>

            <div className="flex items-center gap-2">
              <Button
                onClick={() =>
                  connect.mutate(
                    { bankCode, accountNumber: accountNumber.replace(/\s/g, '') },
                    {
                      onSuccess: () => {
                        setEditing(false);
                        setAccountNumber('');
                      },
                    },
                  )
                }
                disabled={!canSave || connect.isPending}
                leadingIcon={
                  connect.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <Wallet className="h-4 w-4" strokeWidth={2} />
                  )
                }
              >
                {connect.isPending ? 'Checking…' : status.connected ? 'Save' : 'Connect payouts'}
              </Button>

              {status.connected && editing && (
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>

            {connect.isError && (
              <p role="alert" className="text-sm text-danger">
                {connect.error.message}
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-text-muted">
          Customers can pay with MTN MoMo, Telecel Cash, AirtelTigo Money or a card. Flowdesk
          keeps {status.commissionPercent}% of each payment; the rest is settled to you
          directly by Paystack. Money never passes through a Flowdesk account.
        </p>
      </div>
    </Panel>
  );
}
