import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { InvoiceCheckout, type InvoiceCheckoutView } from '@/components/orders/InvoiceCheckout';
import { useCustomers } from '@/hooks/useCustomers';
import { apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

type Summary = { id: string; reference: string; status: string; total: string; customer: { name: string | null } };
type Invoice = InvoiceCheckoutView & { reference: string; status: string; total: string; paid: string; due: string; dueAt: string; terms: string | null;
  receiptLines: { name: string; quantity: number; subtotal: string }[] };
type Reminder = { id: string; status: string; reason: string | null; send: { state: string; attempts: number; reason: string | null } | null };
type Policy = { enabled: boolean; intervalDays: number; maxReminders: number; templateName: string | null; templateLanguage: string | null; approvedAt?: string | null };
const field = 'w-full min-w-0 rounded border border-border bg-transparent p-2';
const labels: Record<string, string> = { DRAFT: 'Draft', ISSUED: 'Issued', PARTIALLY_PAID: 'Partially paid', PAYMENT_PENDING: 'Waiting for payment',
  CHECKOUT_INITIALIZING: 'Preparing a payment request', VERIFIED_PAID: 'Verified payment', CANCELLED: 'Cancelled', REVIEW_REQUIRED: 'Needs review' };

function ReminderSettings({ policy }: { policy: Policy | null }): React.JSX.Element {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Policy>(policy ?? { enabled: false, intervalDays: 3, maxReminders: 2, templateName: null, templateLanguage: null });
  const save = useMutation({ mutationFn: () => apiFetch('/commerce/reminders/policy', { method: 'PUT', body: {
    enabled: draft.enabled, intervalDays: draft.intervalDays, maxReminders: draft.maxReminders, templateName: draft.templateName,
    templateLanguage: draft.templateLanguage,
  } }), onSuccess: () => { void client.invalidateQueries({ queryKey: ['commerce', 'reminder-policy'] }); } });
  return <details>
    <summary className="cursor-pointer font-medium">Payment reminder settings</summary>
    <form className="mt-2 grid max-w-lg gap-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enable reminders for opted-in customers</label>
      <label>Days between reminders <input className={field} type="number" min="1" max="30" required value={draft.intervalDays}
        onChange={(event) => setDraft({ ...draft, intervalDays: Number(event.target.value) })} /></label>
      <label>Maximum reminders <input className={field} type="number" min="1" max="3" required value={draft.maxReminders}
        onChange={(event) => setDraft({ ...draft, maxReminders: Number(event.target.value) })} /></label>
      <label>WhatsApp utility template name <input className={field} value={draft.templateName ?? ''}
        onChange={(event) => setDraft({ ...draft, templateName: event.target.value || null })} /></label>
      <label>Template language <input className={field} value={draft.templateLanguage ?? ''}
        onChange={(event) => setDraft({ ...draft, templateLanguage: event.target.value || null })} /></label>
      <p>{policy?.approvedAt ? `Template checked on ${policy.approvedAt.slice(0, 10)}.` : 'Outside a WhatsApp conversation window, reminders wait for a verified template.'}</p>
      <p>Customers can send START PAYMENT REMINDERS or STOP PAYMENT REMINDERS in WhatsApp.</p>
      {save.isError && <p role="alert">{save.error.message}</p>}
      <div><Button type="submit" size="sm" isLoading={save.isPending}>Save reminder settings</Button></div>
    </form>
  </details>;
}

function DraftForm({ onCreate }: { onCreate: (id: string) => void }): React.JSX.Element {
  const customers = useCustomers();
  const [lines, setLines] = useState([{ description: '', quantity: 1, price: '' }]);
  const [customerId, setCustomerId] = useState('');
  const [due, setDue] = useState('');
  const [terms, setTerms] = useState('');
  const create = useMutation({ mutationFn: () => apiFetch<Summary>('/commerce/invoices', { method: 'POST', body: {
    customerId, dueAt: new Date(due + 'T23:59:59.000Z').toISOString(), terms,
    lines: lines.map((line) => ({ description: line.description, quantity: line.quantity, unitMinor: Math.round(Number(line.price) * 100) })),
  } }), onSuccess: (invoice) => onCreate(invoice.id) });
  return <form className="grid max-w-lg gap-2" aria-label="New invoice" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
    <label>Customer <select className={field} required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
      <option value="">Select a customer</option>
      {customers.data?.map((customer) => <option key={customer.id} value={customer.id}>{customer.name ?? customer.waNumber}</option>)}
    </select></label>
    {customers.isError && <p role="alert">Customers could not be loaded.</p>}
    <label>Due date <input className={field} type="date" required value={due} onChange={(event) => setDue(event.target.value)} /></label>
    <label>Payment terms <input className={field} maxLength={240} value={terms} onChange={(event) => setTerms(event.target.value)} /></label>
    {lines.map((line, index) => <fieldset className="grid gap-2 rounded-md border border-border p-2" key={index}>
      <legend>Invoice item {index + 1}</legend>
      <label>Description <input className={field} required maxLength={120} value={line.description}
        onChange={(event) => setLines(lines.map((entry, i) => i === index ? { ...entry, description: event.target.value } : entry))} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label>Quantity <input className={field} type="number" min="1" max="1000" required value={line.quantity}
          onChange={(event) => setLines(lines.map((entry, i) => i === index ? { ...entry, quantity: Number(event.target.value) } : entry))} /></label>
        <label>Unit price (GHS) <input className={field} type="number" step="0.01" min="0.01" required value={line.price}
          onChange={(event) => setLines(lines.map((entry, i) => i === index ? { ...entry, price: event.target.value } : entry))} /></label>
      </div>
      {lines.length > 1 && <div><Button type="button" size="sm" variant="secondary" onClick={() => setLines(lines.filter((_, i) => i !== index))}>Remove item</Button></div>}
    </fieldset>)}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={lines.length >= 12} onClick={() => setLines([...lines, { description: '', quantity: 1, price: '' }])}>Add invoice item</Button>
      <Button type="submit" size="sm" isLoading={create.isPending}>Save draft</Button>
    </div>
    {create.isError && <p role="alert">{create.error.message}</p>}
  </form>;
}

export function CommerceInvoices(): React.JSX.Element {
  const client = useQueryClient();
  const [draft, setDraft] = useState(false);
  const [selected, select] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['commerce', 'standalone-invoices'], queryFn: () => apiFetch<Summary[]>('/commerce/invoices?standalone=true') });
  const details = useQuery({ queryKey: ['commerce', 'standalone-invoice', selected], enabled: Boolean(selected), refetchInterval: 3_000,
    queryFn: () => apiFetch<Invoice>('/commerce/invoices/' + selected) });
  const reminders = useQuery({ queryKey: ['commerce', 'reminders', selected], enabled: Boolean(selected), refetchInterval: 5_000,
    queryFn: () => apiFetch<Reminder[]>('/commerce/invoices/' + selected + '/reminders') });
  const policy = useQuery({ queryKey: ['commerce', 'reminder-policy'], queryFn: () => apiFetch<Policy | null>('/commerce/reminders/policy') });
  const action = useMutation({ mutationFn: (decision: 'ISSUE' | 'CANCEL' | 'SEND') => apiFetch(`/commerce/invoices/${selected}/decision`, {
    method: 'POST', body: { action: decision },
  }), onSettled: () => { void client.invalidateQueries({ queryKey: ['commerce'] }); } });
  const invoice = details.data;
  return <div className="grid gap-3 px-4 py-3 text-sm">
    {policy.isSuccess && <ReminderSettings policy={policy.data} />}
    <div><Button size="sm" variant="secondary" onClick={() => setDraft(!draft)}>{draft ? 'Close invoice form' : 'New standalone invoice'}</Button></div>
    {draft && <DraftForm onCreate={(id) => { select(id); setDraft(false); void list.refetch(); }} />}
    {list.isPending && <p role="status">Loading invoices…</p>}
    {list.isError && <Button size="sm" variant="secondary" onClick={() => { void list.refetch(); }}>Retry loading invoices</Button>}
    {list.data?.length === 0 && <p>No standalone invoices yet.</p>}
    <ul className="grid gap-2">
      {list.data?.map((entry) => <li key={entry.id}>
        <button type="button" className="block max-w-full break-all text-left text-primary underline" onClick={() => { action.reset(); select(entry.id); }}>{entry.reference}</button>
        <p>{entry.customer.name ?? 'Customer'} · {formatCurrency(Number(entry.total))}</p>
      </li>)}
    </ul>
    {selected && details.isPending && <p role="status">Loading invoice…</p>}
    {selected && details.isError && <Button size="sm" variant="secondary" onClick={() => { void details.refetch(); }}>Retry invoice</Button>}
    {invoice && <section aria-label="Standalone invoice" className="grid gap-2 rounded-md border border-border p-3">
      <h3 className="break-all font-semibold">{invoice.reference}</h3>
      <p>{labels[invoice.state] ?? invoice.state} · Due {invoice.dueAt.slice(0, 10)}</p>
      {invoice.terms && <p>{invoice.terms}</p>}
      <ul>{invoice.receiptLines.map((line, index) => <li key={index}>{line.quantity} × {line.name} · {formatCurrency(Number(line.subtotal))}</li>)}</ul>
      <p>Total {formatCurrency(Number(invoice.total))} · Recorded {formatCurrency(Number(invoice.paid))} · Balance {formatCurrency(Number(invoice.due))}</p>
      <div className="flex flex-wrap gap-2">
        {invoice.status === 'DRAFT' && <Button size="sm" disabled={action.isPending} onClick={() => action.mutate('ISSUE')}>Issue invoice</Button>}
        {invoice.status === 'ISSUED' && <Button size="sm" variant="secondary" disabled={action.isPending} onClick={() => action.mutate('SEND')}>Send invoice</Button>}
        {invoice.status !== 'CANCELLED' && <Button size="sm" variant="secondary" disabled={action.isPending} onClick={() => action.mutate('CANCEL')}>Cancel invoice</Button>}
      </div>
      <InvoiceCheckout key={invoice.id} invoice={invoice} partial onChange={() => { void details.refetch(); }} />
      {action.isError && <p role="alert">{action.error.message}</p>}
      {action.isSuccess && <p role="status">Invoice updated.</p>}
      <h4 className="font-medium">Payment reminders</h4>
      {reminders.isError && <p role="alert">Reminder status is unavailable.</p>}
      {reminders.data?.length === 0 && <p>No reminders recorded.</p>}
      {reminders.data?.map((reminder) => <p key={reminder.id}>{(reminder.send?.state ?? reminder.status).replaceAll('_', ' ')}
        {(reminder.send?.reason ?? reminder.reason) && ` · ${(reminder.send?.reason ?? reminder.reason)!.replaceAll('_', ' ').toLowerCase()}`}</p>)}
    </section>}
  </div>;
}
