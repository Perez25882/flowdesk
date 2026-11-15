import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCreatePayment } from '@/hooks/usePayments';
import { clearManualPayment, isRejectedFirstPaymentSubmission, loadManualPayment, prepareManualPayment } from '@/lib/manual-payment';
import { formatCurrency } from '@/lib/utils';

const METHODS = [
  { value: 'MOMO_MTN', label: 'MTN MoMo' },
  { value: 'MOMO_VODAFONE', label: 'Telecel Cash' },
  { value: 'MOMO_AIRTELTIGO', label: 'AirtelTigo Money' },
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'OTHER', label: 'Other' },
];

export default function ManualPaymentForm({ slot, orderId, customerId, remaining }: {
  slot: string; orderId: string; customerId: string; remaining: number;
}): React.JSX.Element | null {
  const [saved] = useState(() => {
    try {
      return { pending: loadManualPayment(sessionStorage, slot), error: null };
    } catch {
      return { pending: null, error: 'This browser could not read the saved payment request.' };
    }
  });
  const [pending, setPending] = useState(saved.pending);
  const [amount, setAmount] = useState(() => saved.pending?.data.amount.toString() ?? '');
  const [method, setMethod] = useState(saved.pending?.data.method ?? METHODS[0]!.value);
  const [reference, setReference] = useState(saved.pending?.data.reference ?? '');
  const [error, setError] = useState<string | null>(saved.error);
  const creating = useCreatePayment();
  const sending = useRef(false);

  async function submit(): Promise<void> {
    if (sending.current) return;
    const number = Number(amount);
    if (!pending && (!Number.isFinite(number) || number <= 0 || remaining <= 0)) return;
    sending.current = true;
    setError(null);
    try {
      const hadUnconfirmedSubmission = loadManualPayment(sessionStorage, slot) !== null;
      const request = prepareManualPayment(sessionStorage, slot, {
        customerId, orderId, amount: number, method, ...(reference ? { reference } : {}),
      });
      if (request.data.customerId !== customerId || request.data.orderId !== orderId) {
        throw new Error('The saved payment belongs to a different order or customer.');
      }
      setPending(request);
      try {
        await creating.mutateAsync(request);
      } catch (failure) {
        if (isRejectedFirstPaymentSubmission(failure, hadUnconfirmedSubmission)) {
          clearManualPayment(sessionStorage, slot, request.key);
          setPending(null);
        }
        throw failure;
      }
      clearManualPayment(sessionStorage, slot, request.key);
      setPending(null);
      setAmount('');
      setReference('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The payment request could not be confirmed.');
    } finally {
      sending.current = false;
    }
  }

  if (remaining <= 0 && !pending && !error) return null;
  return (
    <section className="border-t border-border-subtle py-5">
      <h3 className="fd-label mb-3">{pending ? 'Confirm a submitted payment' : 'Or record one you already took'}</h3>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input type="number" inputMode="decimal" min={0.01} step={0.01} max={remaining}
            value={amount} onChange={(event) => setAmount(event.target.value)} disabled={!!pending}
            aria-label="Amount received" placeholder={formatCurrency(remaining)}
            className="fd-input fd-input-compact h-11 w-full py-0 sm:h-10 sm:flex-1" />
          <select aria-label="How they paid" value={method} disabled={!!pending}
            onChange={(event) => setMethod(event.target.value)}
            className="fd-input fd-select fd-input-compact h-11 w-full py-0 sm:h-10 sm:w-[150px]">
            {METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        <input type="text" value={reference} onChange={(event) => setReference(event.target.value)}
          aria-label="Transaction reference" placeholder="Transaction ID, if you have one" disabled={!!pending}
          className="fd-input fd-input-compact h-11 py-0 sm:h-10" />
        <Button size="sm" variant="secondary" className="h-10" onClick={() => void submit()}
          disabled={!pending && (!amount || Number(amount) <= 0 || remaining <= 0)} isLoading={creating.isPending}>
          {pending ? 'Retry submitted payment' : `Record ${amount ? formatCurrency(Number(amount) || 0) : 'payment'}`}
        </Button>
        {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      </div>
    </section>
  );
}
