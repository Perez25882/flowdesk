import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { ReturnCaseContents, type ReturnCase } from '@/components/orders/OrderReturns';
import { isOwner, can, isOperationsStaff } from '@/hooks/useAuth';
import { useStaff } from '@/hooks/useStaff';
import { useProducts } from '@/hooks/useProducts';
import { useCustomers } from '@/hooks/useCustomers';
import { decodeToken } from '@/lib/api';

type Policy = { enabled: boolean; allowPickup: boolean; allowDelivery: boolean; quoteMinutes: number;
  invoiceDays: number; depositPercent: number; releaseOnDeposit: boolean; allowFollowup: boolean; revision: number };
type Quote = { id: string; state: string; total: string; specification?: string;
  lines: { productId: string; itemName: string; quantity: number }[] };
type Case = { id: string; kind: string; state: string; revision: number;
  customer?: { name: string | null }; order?: { referenceNumber: string; status: string } };
type CaseDetail = ReturnCase & { canReceiveReturn: boolean; assignedStaffId: string | null; customerId: string; history: { resolution: string | null }[] };

function QuoteForm(): React.JSX.Element {
  const { data: customers, error: customerError } = useCustomers();
  const { data: products, error: productError } = useProducts();
  const client = useQueryClient();
  const [delivery, setDelivery] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const create = useMutation({ mutationFn: (fields: FormData) => apiFetch('/commerce/quotes', { method: 'POST', body: {
    requestKey: key, customerId: String(fields.get('customer')),
    deliveryMode: delivery ? 'DELIVERY' : 'PICKUP', ...(delivery ? { address: String(fields.get('address')) } : {}),
    ...(String(fields.get('specification')).trim() ? { specification: String(fields.get('specification')) } : {}),
    items: [{ productId: String(fields.get('product')), quantity: Number(fields.get('quantity')) }],
  } }), onSuccess: () => { setKey(crypto.randomUUID()); void client.invalidateQueries({ queryKey: ['commerce', 'quotes'] }); } });
  const field = 'block w-full rounded-md border border-border bg-surface p-2';
  return <details className="border-b border-border px-4 py-3">
    <summary className="min-h-8 cursor-pointer font-medium">Create a quote</summary>
    <form className="mt-2 grid max-w-xl gap-2 text-sm" onSubmit={(event) => {
      event.preventDefault();
      if (!create.isPending) create.mutate(new FormData(event.currentTarget));
    }}>
      {(customerError || productError) && <p role="alert">Customers or products could not load.</p>}
      <label>Customer<select className={field} name="customer" required defaultValue=""><option value="">Select a customer</option>
        {customers?.filter((item) => !item.blacklisted).map((item) => <option key={item.id} value={item.id}>{item.name || item.waNumber}</option>)}</select></label>
      <label>Product<select className={field} name="product" required defaultValue=""><option value="">Select a product</option>
        {products?.filter((item) => item.commerceMode === 'TRACKED' || item.commerceMode === 'MADE_TO_ORDER').map((item) =>
          <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Quantity<input className={field} name="quantity" type="number" min={1} max={1000} required defaultValue={1} /></label>
      <label>Fulfillment<select className={field} value={delivery ? 'delivery' : 'pickup'} onChange={(event) => setDelivery(event.target.value === 'delivery')}>
        <option value="pickup">Pickup</option><option value="delivery">Delivery</option></select></label>
      {delivery && <label>Delivery address<input className={field} name="address" minLength={5} maxLength={300} required /></label>}
      <label>Customer specifications<textarea className={field} name="specification" maxLength={700} /></label>
      <Button className="justify-self-start" size="sm" type="submit" isLoading={create.isPending}>Save quote</Button>
      {create.isError && <p role="alert">{create.error.message}</p>}
      {create.isSuccess && <p role="status">Quote recorded using current catalogue terms.</p>}
    </form>
  </details>;
}

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

export default function CommercePanel({ section }: { section: 'quotes' | 'cases' }): React.JSX.Element {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get('case');
  const owner = isOwner();
  const operationsId = isOperationsStaff() ? decodeToken()?.staffId : undefined;
  const staff = useStaff(section === 'cases' && can('staff.read'));
  const [assignee, setAssignee] = useState('');
  const policy = useQuery({ queryKey: ['commerce', 'policy'], queryFn: () => apiFetch<Policy | null>('/commerce/policy'),
    enabled: section === 'quotes' && owner });
  const quotes = useQuery({ queryKey: ['commerce', 'quotes'], queryFn: () => apiFetch<Quote[]>('/commerce/quotes'),
    enabled: section === 'quotes', refetchInterval: 15_000 });
  const cases = useQuery({ queryKey: ['commerce', 'cases'], queryFn: () => apiFetch<Case[]>('/commerce/cases'),
    enabled: section === 'cases', refetchInterval: 15_000 });
  const detail = useQuery({ queryKey: ['commerce', 'case', selected], enabled: section === 'cases' && Boolean(selected),
    queryFn: () => apiFetch<CaseDetail>('/commerce/cases/' + encodeURIComponent(selected!)), refetchInterval: 15_000 });
  const caseRow = cases.data?.find((item) => item.id === selected);
  const decision = useMutation({ mutationFn: ({ id, choice }: { id: string; choice: 'OFFER' | 'DECLINE' }) =>
    apiFetch('/commerce/quotes/' + id + '/decision', { method: 'POST', body: { decision: choice } }),
  onSettled: () => { void client.invalidateQueries({ queryKey: ['commerce', 'quotes'] }); } });
  const caseAction = useMutation({ mutationFn: (state: 'ASSIGNED' | 'WAITING' | 'ESCALATED' | 'RESOLVED' | 'RECEIVED') => {
    const current = detail.data!;
    if (state === 'RECEIVED') return apiFetch('/commerce/cases/' + current.id + '/receive-return', {
      method: 'POST', body: { revision: current.revision },
    });
    const cancelled = caseRow?.kind === 'CANCELLATION' && caseRow.order?.status === 'CANCELLED';
    return apiFetch('/commerce/cases/' + current.id, { method: 'PATCH', body: {
      state, revision: current.revision, staffId: state === 'ASSIGNED' ? (operationsId ?? assignee) : (operationsId ?? current.assignedStaffId),
      ...(state === 'RESOLVED' ? { resolution: cancelled ? 'CANCELLATION_CONFIRMED' : 'CUSTOMER_CONFIRMED_RESOLUTION',
        ...(!cancelled ? { evidenceMessageId: current.customerConfirmationId } : {}) } : {}),
    } });
  }, onSettled: () => { void client.invalidateQueries({ queryKey: ['commerce'] }); } });
  return (
    <Panel>
      <PanelHead title={section === 'quotes' ? 'Quotes' : 'Customer cases'} />
      {section === 'quotes' && owner && policy.isPending && <p role="status" className="px-4 py-3 text-sm">Loading checkout settings…</p>}
      {policy.isError && <p role="alert" className="px-4 py-3 text-sm">Commerce settings could not be loaded.</p>}
      {policy.isSuccess && <PolicyForm key={policy.data?.revision ?? 0} policy={policy.data} />}
      {section === 'quotes' && (!owner || policy.data?.enabled) && <QuoteForm />}
      <>
        {(section === 'quotes' ? quotes.isPending : cases.isPending) && <p role="status" className="px-4 py-3 text-sm">Loading…</p>}
        {(section === 'quotes' ? quotes.isError || decision.isError : cases.isError || detail.isError || caseAction.isError) &&
          <p role="alert" className="px-4 py-3 text-sm">{decision.error?.message ?? caseAction.error?.message ?? 'Could not load this view.'}</p>}
        {section === 'quotes' ? <RowList>
          {quotes.data?.length === 0 && <p className="px-4 py-3 text-sm">No quotes yet.</p>}
          {quotes.data?.map((quote) => <Row key={quote.id}>
            <div className="min-w-0 text-sm">
              <p className="font-medium">{quote.lines.map((line) => line.quantity + ' × ' + line.itemName).join(', ')}</p>
              <p>{formatCurrency(Number(quote.total))} · {
                ({ DRAFT: 'Needs approval', OFFERED: 'Waiting for customer', ACCEPTED: 'Accepted', DECLINED: 'Declined', EXPIRED: 'Expired' } as Record<string, string>)[quote.state]}</p>
              {quote.specification && <p>{quote.specification}</p>}
            </div>
            {owner && quote.state === 'DRAFT' && <div className="flex flex-wrap gap-2">
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
              <Button size="sm" variant="secondary" onClick={() => {
                caseAction.reset(); setAssignee(''); setParams((next) => { const update = new URLSearchParams(next); update.set('case', item.id); return update; });
              }}>View case</Button>
            </Row>)}
          </RowList>
          {selected && detail.data && <section className="border-t px-4 py-3 text-sm" aria-label="Customer case">
            <p className="font-medium">{caseNames[detail.data.kind]} · {states[detail.data.state]}</p>
            <Link to={'/messages?c=' + encodeURIComponent(detail.data.customerId)} className="text-primary underline">Open conversation</Link>
            {caseRow?.order && <p className="mt-1">{caseRow.order.referenceNumber}</p>}
            {detail.data.customerConfirmationId && <p>Customer confirmed the resolution.</p>}
            {detail.data.history.some((event) => event.resolution === 'RETURN_RECEIVED_TO_STOCK') && <p>Returned goods were received into stock.</p>}
            {owner && <ReturnCaseContents key={detail.data.id} item={detail.data} refresh={() => { void detail.refetch(); }} />}
            {detail.data.state !== 'RESOLVED' && (!operationsId || !detail.data.assignedStaffId || detail.data.assignedStaffId === operationsId) &&
              <div className="mt-2 flex flex-wrap items-end gap-2">
              {!operationsId && <>
              <label>Assign case <select value={assignee} className="block max-w-full rounded border px-2 py-2"
                onChange={(event) => setAssignee(event.target.value)}>
                <option value="">Choose staff</option>{staff.data?.filter((member) => member.active && member.role !== 'DELIVERY').map((member) =>
                  <option key={member.id} value={member.id}>{member.name}</option>)}
              </select></label>
              </>}
              <Button size="sm" disabled={(!assignee && !operationsId) || caseAction.isPending}
                onClick={() => caseAction.mutate('ASSIGNED')}>{operationsId ? 'Assign to me' : 'Assign case'}</Button>
              <Button size="sm" variant="secondary" disabled={caseAction.isPending} onClick={() => caseAction.mutate('WAITING')}>Wait for customer</Button>
              <Button size="sm" variant="secondary" disabled={caseAction.isPending} onClick={() => caseAction.mutate('ESCALATED')}>Move to review</Button>
              {detail.data.canReceiveReturn &&
                <Button size="sm" variant="secondary" disabled={caseAction.isPending} onClick={() => caseAction.mutate('RECEIVED')}>Record full return received</Button>}
              {(detail.data.customerConfirmationId || (caseRow?.kind === 'CANCELLATION' && caseRow.order?.status === 'CANCELLED')) &&
                <Button size="sm" disabled={caseAction.isPending} onClick={() => caseAction.mutate('RESOLVED')}>Resolve case</Button>}
            </div>}
          </section>}
        </>}
      </>
    </Panel>
  );
}
