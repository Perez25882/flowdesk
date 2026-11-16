import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';

export type InvoiceCheckoutView = {
  id: string; state: string; nextCharge: string; checkoutVersion: string;
  checkout: { reference: string; authorizationUrl: string; expiresAt: string; amount: string } | null;
};

export function InvoiceCheckout({ invoice, partial, onChange }: {
  invoice: InvoiceCheckoutView; partial?: boolean; onChange: () => void;
}): React.JSX.Element | null {
  const submitted = useRef(false);
  const [partialAmount, setPartialAmount] = useState('');
  const send = useMutation({
    mutationFn: (amountMinor: number | undefined) => apiFetch(`/commerce/invoices/${invoice.id}/checkout`, { method: 'POST', body: {
      send: true, checkoutVersion: invoice.checkoutVersion, ...(amountMinor === undefined ? {} : { amountMinor }),
    } }),
    onSettled: () => { submitted.current = false; onChange(); },
  });
  if (invoice.state === 'CHECKOUT_INITIALIZING') return <p role="status">The payment link is being prepared. This status updates automatically.</p>;
  if (invoice.state === 'REVIEW_REQUIRED') return <p role="alert">This checkout needs payment review before another link can be issued.</p>;
  if (Number(invoice.nextCharge) <= 0 || ['CANCELLED', 'DRAFT'].includes(invoice.state)) return null;
  const url = invoice.checkout?.authorizationUrl;
  return <div className="grid gap-2">
    {url?.startsWith('https://') && <a className="text-primary underline" href={url} target="_blank" rel="noopener noreferrer">Open existing payment link</a>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (submitted.current) return;
      submitted.current = true;
      const selected = invoice.checkout?.amount ?? (partial ? partialAmount : '');
      send.mutate(selected ? Math.round(Number(selected) * 100) : undefined);
    }}>
      {partial && !invoice.checkout && <label className="grid gap-1">Payment amount (GHS)
        <input className="max-w-40 rounded border bg-transparent p-2" type="number" min="1" step="0.01" max={Number(invoice.nextCharge)}
          value={partialAmount} placeholder={invoice.nextCharge} onChange={(event) => setPartialAmount(event.target.value)} />
      </label>}
      <Button type="submit" size="sm" variant="secondary" disabled={send.isPending}>Send payment link</Button>
    </form>
    {send.isPending && <p role="status">Requesting payment link…</p>}
    {send.isError && <p role="alert">{send.error.message} The invoice will reload its current payment status.</p>}
    {send.isSuccess && <p role="status">Payment link is ready.</p>}
  </div>;
}
