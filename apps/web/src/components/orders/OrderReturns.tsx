import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { isOwner } from '@/hooks/useAuth';

export type ReturnCase = {
  id: string; revision: number; kind: string; state: string; customerConfirmationId: string | null;
  order?: { status: string; items: { id: string; description: string; quantity: string; product: { commerceMode: string | null } | null }[] } | null;
  returns: { id: string; obligation: string; approvedAt: string | null; rejectedAt: string | null; resolvedAt: string | null;
    resolutionPayment: { voidedAt: string | null } | null;
    lines: { orderItemId: string; quantity: number; condition: string; movementId: string | null }[] }[];
};
const input = 'w-full rounded border border-border bg-transparent p-2';
const obligations: Record<string, string> = { NONE: 'None', REFUND_REVIEW: 'Refund review', REPLACEMENT: 'Replacement', EXCHANGE: 'Exchange' };

export function ReturnCaseContents({ item, refresh }: { item: ReturnCase; refresh: () => void }): React.JSX.Element | null {
  const [selectedItem, selectItem] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('REVIEW');
  const [obligation, setObligation] = useState('NONE');
  const [evidence, setEvidence] = useState('');
  const [lines, setLines] = useState<{ orderItemId: string; quantity: number; condition: string }[]>([]);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [refundId, setRefundId] = useState('');
  const action = useMutation({ mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
    apiFetch(`/commerce/cases/${item.id}/returns${path}`, { method: 'POST', body }),
  onSuccess: (_, variables) => {
    if (variables.path === '') { setLines([]); selectItem(''); setEvidence(''); setRequestKey(crypto.randomUUID()); }
    refresh();
  }, onError: refresh });
  if (!['RETURN', 'EXCHANGE'].includes(item.kind) || item.order?.status !== 'FULFILLED') return null;
  const choices = item.order.items;
  const original = choices.find((entry) => entry.id === selectedItem);
  return <div className="mt-3 grid gap-3" aria-label="Item returns">
    {item.state !== 'RESOLVED' && <details>
      <summary className="cursor-pointer font-medium">Record item return</summary>
      <form className="mt-2 grid max-w-lg gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (lines.length) action.mutate({ path: '', body: { requestKey, revision: item.revision, evidence, obligation, lines } });
      }}>
        <label>Order item <select className={input} value={selectedItem} onChange={(event) => { selectItem(event.target.value); setCondition('REVIEW'); }}>
          <option value="">Choose a returned item</option>
          {choices.filter((entry) => !lines.some((line) => line.orderItemId === entry.id)).map((entry) =>
            <option value={entry.id} key={entry.id}>{entry.description} ({entry.quantity} purchased)</option>)}
        </select></label>
        <label>Returned quantity <input className={input} type="number" min="1" max={Number(original?.quantity ?? 1000)}
          value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
        <label>Condition <select className={input} value={condition} onChange={(event) => setCondition(event.target.value)}>
          <option value="REVIEW">Needs review</option><option value="DAMAGED">Damaged</option>
          {original?.product?.commerceMode === 'TRACKED' && <option value="RESTOCKABLE">Restockable</option>}
        </select></label>
        <div><Button type="button" size="sm" variant="secondary" disabled={!original || quantity < 1 || quantity > Number(original.quantity)}
          onClick={() => { setLines([...lines, { orderItemId: selectedItem, quantity, condition }]); selectItem(''); setQuantity(1); setCondition('REVIEW'); }}>Add returned item</Button></div>
        {lines.map((line) => <div className="flex items-center justify-between gap-2" key={line.orderItemId}>
          <span>{line.quantity} × {choices.find((entry) => entry.id === line.orderItemId)?.description}</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => setLines(lines.filter((entry) => entry !== line))}>Remove</Button>
        </div>)}
        <label>Custody evidence <textarea className={input} required minLength={4} maxLength={350} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
        <label>Outstanding obligation <select className={input} value={obligation} onChange={(event) => setObligation(event.target.value)}>
          {Object.entries(obligations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <div><Button type="submit" size="sm" disabled={!lines.length} isLoading={action.isPending}>Record custody for approval</Button></div>
      </form>
    </details>}
    {item.returns.map((receipt) => <div key={receipt.id} className="grid gap-2 rounded border border-border p-2">
      <p>{receipt.rejectedAt ? 'Needs review' : receipt.approvedAt ? 'Custody approved' : 'Awaiting owner approval'}</p>
      <ul>{receipt.lines.map((line) => <li key={line.orderItemId}>
        {line.quantity} × {choices.find((entry) => entry.id === line.orderItemId)?.description}{line.movementId ? ' · Stock restored' : ''}
      </li>)}</ul>
      {receipt.obligation !== 'NONE' && <p>{obligations[receipt.obligation]} · {receipt.resolutionPayment?.voidedAt
        ? 'Recorded refund was voided' : receipt.resolvedAt ? 'Evidence recorded' : 'Outstanding'}</p>}
      {isOwner() && !receipt.approvedAt && !receipt.rejectedAt && item.state !== 'RESOLVED' && <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ path: '/' + receipt.id + '/decision', body: { approve: true } })}>Approve returned items</Button>
        <Button size="sm" variant="secondary" disabled={action.isPending} onClick={() => action.mutate({ path: '/' + receipt.id + '/decision', body: { approve: false } })}>Move return to review</Button>
      </div>}
      {receipt.approvedAt && (!receipt.resolvedAt || receipt.resolutionPayment?.voidedAt) && receipt.obligation === 'REFUND_REVIEW' && isOwner() && <div className="grid gap-2">
        <label>Recorded refund ID <input className={input} value={refundId} onChange={(event) => setRefundId(event.target.value)} /></label>
        <div><Button size="sm" disabled={!refundId || action.isPending} onClick={() => action.mutate({ path: '/' + receipt.id + '/resolution', body: { paymentId: refundId } })}>Link recorded refund</Button></div>
      </div>}
      {receipt.approvedAt && !receipt.resolvedAt && ['REPLACEMENT', 'EXCHANGE'].includes(receipt.obligation) && item.customerConfirmationId &&
        <div><Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ path: '/' + receipt.id + '/resolution',
          body: { evidenceMessageId: item.customerConfirmationId } })}>Record confirmed {receipt.obligation.toLowerCase()}</Button></div>}
    </div>)}
    {action.isError && <p role="alert">{action.error.message}</p>}
  </div>;
}

export function OrderReturns({ orderId }: { orderId: string }): React.JSX.Element {
  const open = useMutation({ mutationFn: () => apiFetch<{ id: string }>(`/commerce/orders/${orderId}/return-case`, { method: 'POST', body: {} }) });
  const detail = useQuery({ queryKey: ['commerce', 'order-return', open.data?.id], enabled: Boolean(open.data),
    queryFn: () => apiFetch<ReturnCase>('/commerce/cases/' + open.data?.id), refetchInterval: 5_000 });
  return <section className="grid gap-2 rounded border border-border p-3 text-sm" aria-label="Order return">
    <div><Button size="sm" variant="secondary" isLoading={open.isPending} onClick={() => open.mutate()}>Open item return case</Button></div>
    {open.isError && <p role="alert">{open.error.message}</p>}
    {detail.data && <ReturnCaseContents key={detail.data.id} item={detail.data} refresh={() => { void detail.refetch(); }} />}
  </section>;
}
