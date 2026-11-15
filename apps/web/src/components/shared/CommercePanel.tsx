import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

type Policy = { enabled: boolean; allowPickup: boolean; allowDelivery: boolean; quoteMinutes: number;
  invoiceDays: number; depositPercent: number; releaseOnDeposit: boolean; allowFollowup: boolean; revision: number };
type Quote = { id: string; state: string; total: string; specification?: string;
  lines: { productId: string; itemName: string; quantity: number }[] };
type Case = { id: string; kind: string; state: string; revision: number;
  customer?: { name: string | null }; order?: { referenceNumber: string; status: string } };
type CaseDetail = Case & { customerConfirmationId: string | null; canReceiveReturn: boolean; history: { resolution: string | null }[] };

function PolicyForm({ policy }: { policy: Policy | null }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Policy>(policy ? {
    enabled: policy.enabled, allowPickup: policy.allowPickup, allowDelivery: policy.allowDelivery,
    quoteMinutes: policy.quoteMinutes, invoiceDays: policy.invoiceDays, depositPercent: policy.depositPercent,
    releaseOnDeposit: policy.releaseOnDeposit, allowFollowup: policy.allowFollowup, revision: policy.revision,
  } : { enabled: false, allowPickup: true, allowDelivery: false, quoteMinutes: 30,
    invoiceDays: 7, depositPercent: 0, releaseOnDeposit: false, allowFollowup: false, revision: 0 });
  const save = useMutation({
    mutationFn: () => apiFetch('/commerce/policy', { method: 'PUT', body: draft }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['commerce'] }); },
  });
  return (
    <details className="px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">Commerce settings</summary>
      <form className="mt-3 grid max-w-xl gap-3 text-sm" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <label><input type="checkbox" checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enable commerce in WhatsApp</label>
        <label><input type="checkbox" checked={draft.allowPickup}
          onChange={(event) => setDraft({ ...draft, allowPickup: event.target.checked })} /> Offer pickup</label>
        <label><input type="checkbox" checked={draft.allowDelivery}
          onChange={(event) => setDraft({ ...draft, allowDelivery: event.target.checked })} /> Offer delivery</label>
        <label className="grid gap-1">Quote expiry (minutes)
          <input className="max-w-xs rounded border bg-transparent p-2" type="number" min="5" max="1440"
            value={draft.quoteMinutes} onChange={(event) => setDraft({ ...draft, quoteMinutes: Number(event.target.value) })} />
        </label>
        <label className="grid gap-1">Invoice due in days
          <input className="max-w-xs rounded border bg-transparent p-2" type="number" min="1" max="90"
            value={draft.invoiceDays} onChange={(event) => setDraft({ ...draft, invoiceDays: Number(event.target.value) })} />
        </label>
        <label className="grid gap-1">Deposit percentage
          <input className="max-w-xs rounded border bg-transparent p-2" type="number" min="0" max="90"
            value={draft.depositPercent} onChange={(event) => setDraft({ ...draft, depositPercent: Number(event.target.value),
              releaseOnDeposit: Number(event.target.value) > 0 && draft.releaseOnDeposit })} />
        </label>
        {draft.depositPercent > 0 && <label><input type="checkbox" checked={draft.releaseOnDeposit}
          onChange={(event) => setDraft({ ...draft, releaseOnDeposit: event.target.checked })} /> Begin preparation after a verified deposit</label>}
        <label><input type="checkbox" checked={draft.allowFollowup}
          onChange={(event) => setDraft({ ...draft, allowFollowup: event.target.checked })} /> Allow one owner-approved follow-up for customers who opt in</label>
        {save.isError && <p role="alert">{save.error.message}</p>}
        <div><Button type="submit" size="sm" isLoading={save.isPending}>Save commerce settings</Button></div>
      </form>
    </details>
  );
}

const caseNames: Record<string, string> = {
  COMPLAINT: 'Complaint', CANCELLATION: 'Cancellation request', RETURN: 'Return request', EXCHANGE: 'Exchange request',
};
const states: Record<string, string> = {
  OPEN: 'Open', ASSIGNED: 'Assigned', WAITING: 'Waiting for customer', ESCALATED: 'Needs review', RESOLVED: 'Resolved',
};

export default function CommercePanel(): React.JSX.Element {
  const client = useQueryClient();
  const [tab, setTab] = useState<'quotes' | 'cases'>('quotes');
  const [selected, select] = useState<Case | null>(null);
  const policy = useQuery({ queryKey: ['commerce', 'policy'], queryFn: () => apiFetch<Policy | null>('/commerce/policy') });
  const quotes = useQuery({ queryKey: ['commerce', 'quotes'], queryFn: () => apiFetch<Quote[]>('/commerce/quotes'),
    enabled: policy.data?.enabled === true, refetchInterval: 5_000 });
  const cases = useQuery({ queryKey: ['commerce', 'cases'], queryFn: () => apiFetch<Case[]>('/commerce/cases'),
    enabled: policy.data?.enabled === true, refetchInterval: 5_000 });
  const detail = useQuery({ queryKey: ['commerce', 'case', selected?.id], enabled: Boolean(selected),
    queryFn: () => apiFetch<CaseDetail>('/commerce/cases/' + selected?.id), refetchInterval: 5_000 });
  const decision = useMutation({ mutationFn: ({ id, choice }: { id: string; choice: 'OFFER' | 'DECLINE' }) =>
    apiFetch('/commerce/quotes/' + id + '/decision', { method: 'POST', body: { decision: choice } }),
  onSettled: () => { void client.invalidateQueries({ queryKey: ['commerce', 'quotes'] }); } });
  const caseAction = useMutation({ mutationFn: (state: 'WAITING' | 'ESCALATED' | 'RESOLVED' | 'RECEIVED') => {
    const current = detail.data!;
    if (state === 'RECEIVED') return apiFetch('/commerce/cases/' + current.id + '/receive-return', {
      method: 'POST', body: { revision: current.revision },
    });
    const cancelled = selected?.kind === 'CANCELLATION' && selected.order?.status === 'CANCELLED';
    return apiFetch('/commerce/cases/' + current.id, { method: 'PATCH', body: {
      state, revision: current.revision, staffId: null,
      ...(state === 'RESOLVED' ? { resolution: cancelled ? 'CANCELLATION_CONFIRMED' : 'CUSTOMER_CONFIRMED_RESOLUTION',
        ...(!cancelled ? { evidenceMessageId: current.customerConfirmationId } : {}) } : {}),
    } });
  }, onSettled: () => { void client.invalidateQueries({ queryKey: ['commerce'] }); } });
  return (
    <Panel>
      <PanelHead title="Commerce" />
      {policy.isPending && <p className="px-4 py-3 text-sm">Loading commerce…</p>}
      {policy.isError && <p role="alert" className="px-4 py-3 text-sm">Commerce settings could not be loaded.</p>}
      {policy.isSuccess && <PolicyForm key={policy.data?.revision ?? 0} policy={policy.data} />}
      {policy.data?.enabled && <>
        <div className="flex gap-2 px-4 py-2">
          <Button size="sm" variant={tab === 'quotes' ? 'primary' : 'secondary'} onClick={() => setTab('quotes')}>Quotes</Button>
          <Button size="sm" variant={tab === 'cases' ? 'primary' : 'secondary'} onClick={() => setTab('cases')}>Customer cases</Button>
        </div>
        {(tab === 'quotes' ? quotes.isPending : cases.isPending) && <p className="px-4 py-3 text-sm">Loading…</p>}
        {(tab === 'quotes' ? quotes.isError || decision.isError : cases.isError || detail.isError || caseAction.isError) &&
          <p role="alert" className="px-4 py-3 text-sm">{decision.error?.message ?? caseAction.error?.message ?? 'Could not load this view.'}</p>}
        {tab === 'quotes' ? <RowList>
          {quotes.data?.length === 0 && <p className="px-4 py-3 text-sm">No quotes yet.</p>}
          {quotes.data?.map((quote) => <Row key={quote.id}>
            <div className="min-w-0 text-sm">
              <p className="font-medium">{quote.lines.map((line) => line.quantity + ' × ' + line.itemName).join(', ')}</p>
              <p>{formatCurrency(Number(quote.total))} · {
                ({ DRAFT: 'Needs approval', OFFERED: 'Waiting for customer', ACCEPTED: 'Accepted', DECLINED: 'Declined', EXPIRED: 'Expired' } as Record<string, string>)[quote.state]}</p>
              {quote.specification && <p>{quote.specification}</p>}
            </div>
            {quote.state === 'DRAFT' && <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={decision.isPending} onClick={() => decision.mutate({ id: quote.id, choice: 'OFFER' })}>Approve quote</Button>
              <Button size="sm" variant="secondary" disabled={decision.isPending}
                onClick={() => decision.mutate({ id: quote.id, choice: 'DECLINE' })}>Decline</Button>
            </div>}
          </Row>)}
        </RowList> : <>
          <RowList>
            {cases.data?.length === 0 && <p className="px-4 py-3 text-sm">No customer cases yet.</p>}
            {cases.data?.map((item) => <Row key={item.id}>
              <div className="text-sm">
                <p className="font-medium">{caseNames[item.kind]} · {item.customer?.name ?? 'WhatsApp customer'}</p>
                <p>{states[item.state]} {item.order ? '· ' + item.order.referenceNumber : ''}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => { caseAction.reset(); select(item); }}>View case</Button>
            </Row>)}
          </RowList>
          {selected && detail.data && <section className="border-t px-4 py-3 text-sm" aria-label="Customer case">
            <p className="font-medium">{caseNames[detail.data.kind]} · {states[detail.data.state]}</p>
            {detail.data.customerConfirmationId && <p>Customer confirmed the resolution.</p>}
            {detail.data.history.some((event) => event.resolution === 'RETURN_RECEIVED_TO_STOCK') && <p>Returned goods were received into stock.</p>}
            {detail.data.state !== 'RESOLVED' && <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={caseAction.isPending} onClick={() => caseAction.mutate('WAITING')}>Wait for customer</Button>
              <Button size="sm" variant="secondary" disabled={caseAction.isPending} onClick={() => caseAction.mutate('ESCALATED')}>Move to review</Button>
              {detail.data.canReceiveReturn &&
                <Button size="sm" variant="secondary" disabled={caseAction.isPending} onClick={() => caseAction.mutate('RECEIVED')}>Record full return received</Button>}
              {(detail.data.customerConfirmationId || (selected.kind === 'CANCELLATION' && selected.order?.status === 'CANCELLED')) &&
                <Button size="sm" disabled={caseAction.isPending} onClick={() => caseAction.mutate('RESOLVED')}>Resolve case</Button>}
            </div>}
          </section>}
        </>}
      </>}
    </Panel>
  );
}
