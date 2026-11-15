import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

type Summary = { id: string };
type Invoice = Summary & { reference: string; total: string; deposit: string; paid: string; due: string; nextCharge: string;
  state: string; dueAt: string; order: { status: string }; followupAvailable: boolean;
  preparation: { state: string; assignedStaffId: string | null; madeToOrder: boolean } | null;
  receiptLines: { name: string; quantity: number; unitPrice: string; subtotal: string }[] };

const names: Record<string, string> = {
  ISSUED: 'Issued', PAYMENT_PENDING: 'Waiting for payment', PARTIALLY_PAID: 'Partially paid',
  VERIFIED_PAID: 'Verified payment', RECORDED_PAID: 'Payment recorded', CANCELLED: 'Cancelled', REVIEW_REQUIRED: 'Needs payment review',
};

export default function OrderInvoice({ orderId, status }: { orderId: string; status: string }): React.JSX.Element | null {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['commerce-invoice', orderId], refetchInterval: 5_000,
    queryFn: () => apiFetch<Summary[]>('/commerce/invoices?orderId=' + encodeURIComponent(orderId)) });
  const id = list.data?.[0]?.id;
  const details = useQuery({ queryKey: ['commerce-invoice-detail', id], enabled: Boolean(id), refetchInterval: 5_000,
    queryFn: () => apiFetch<Invoice>('/commerce/invoices/' + id) });
  const action = useMutation({
    mutationFn: (kind: 'checkout' | 'ready' | 'followup') => {
      if (kind === 'checkout') return apiFetch('/commerce/invoices/' + id + '/checkout', { method: 'POST', body: { send: true } });
      if (kind === 'followup') return apiFetch('/commerce/orders/' + orderId + '/followup', { method: 'POST', body: {} });
      return apiFetch('/commerce/orders/' + orderId + '/preparation', { method: 'PATCH', body: {
        state: 'READY', assignedStaffId: details.data?.preparation?.assignedStaffId ?? null,
      } });
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: ['commerce-invoice-detail', id] }); },
  });
  if (list.isError || details.isError) return <p role="alert" className="text-sm">Could not load the commerce invoice.</p>;
  if (!id) return null;
  const invoice = details.data;
  if (!invoice) return <p className="text-sm" role="status">Loading invoice…</p>;
  return (
    <section aria-label="Commerce invoice" className="grid gap-2 rounded-md border border-border p-3 text-sm">
      <h3 className="font-semibold">Invoice {invoice.reference}</h3>
      <p>{names[invoice.state]} · Due {invoice.dueAt.slice(0, 10)}</p>
      <ul className="grid gap-1">
        {invoice.receiptLines.map((line, index) => <li key={line.name + '-' + index} className="flex justify-between gap-2">
          <span>{line.quantity} × {line.name}</span><span>{formatCurrency(Number(line.subtotal))}</span>
        </li>)}
      </ul>
      <p>Total {formatCurrency(Number(invoice.total))} · Recorded {formatCurrency(Number(invoice.paid))} ·
        Balance {formatCurrency(Number(invoice.due))}</p>
      {invoice.preparation && <p>{invoice.preparation.madeToOrder ? 'Production' : 'Packing'} · {
        ({ PREPARING: 'Awaiting staff completion', READY: 'Ready', COLLECTED: 'Collected', CANCELLED: 'Cancelled' } as Record<string, string>)[invoice.preparation.state]}</p>}
      <div className="flex flex-wrap gap-2">
        {Number(invoice.nextCharge) > 0 && !['CANCELLED', 'REVIEW_REQUIRED'].includes(invoice.state) &&
          <Button size="sm" variant="secondary" disabled={action.isPending} onClick={() => action.mutate('checkout')}>Send payment link</Button>}
        {status === 'PROCESSING' && invoice.preparation?.state === 'PREPARING' &&
          <Button size="sm" disabled={action.isPending} onClick={() => action.mutate('ready')}>Mark preparation complete</Button>}
        {invoice.followupAvailable &&
          <Button size="sm" variant="secondary" disabled={action.isPending} onClick={() => action.mutate('followup')}>Send order follow-up</Button>}
      </div>
      {action.isError && <p role="alert">{action.error.message}</p>}
      {action.isSuccess && <p role="status">Update saved.</p>}
    </section>
  );
}
