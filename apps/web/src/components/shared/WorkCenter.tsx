import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { apiFetch } from '@/lib/api';
import { timeAgo } from '@/lib/utils';

const states: Record<string, string> = {
  CREATED: 'New', READY: 'Ready', RUNNING: 'In progress', WAITING_CUSTOMER: 'Waiting for customer',
  WAITING_OWNER_APPROVAL: 'Needs your decision', WAITING_STAFF: 'Needs staff action',
  WAITING_PROVIDER: 'Waiting for confirmation', RETRY_SCHEDULED: 'Checking again', REVIEW_REQUIRED: 'Needs review',
  COMPLETED: 'Completed', FAILED: 'Closed', CANCELLED: 'Cancelled',
};
const operators: Record<string, string> = {
  SALES: 'Sales & Orders', BOOKINGS: 'Leads & Bookings', PAYMENTS: 'Payments & Invoices',
  FULFILLMENT: 'Fulfillment & Operations', CARE: 'Customer Care & Retention',
};
const steps: Record<string, string> = {
  WHATSAPP_INBOUND: 'Customer wrote on WhatsApp',
  PROCESSING: 'Started checking the request',
  SALES_QUOTE: 'Checked the quote against the catalogue',
  ORDER_LINKED: 'Recorded the order',
  PAYMENT_REQUEST: 'Created a payment link',
  PAYMENT_SETTLED: 'Verified payment',
  DELIVERY_DISPATCHED: 'Shipment dispatched',
  DELIVERY_COMPLETED: 'Shipment delivered',
  APPOINTMENT_BOOKED: 'Appointment booked',
  SUPPORT_LOOKUP: 'Verified the requested information',
  OUTBOUND_AUTHORIZED: 'Prepared the customer reply',
  OUTBOUND_CONFIRMED: 'Confirmed the customer received the message',
  CUSTOMER_INPUT: 'Asked the customer for more details',
  REVIEW: 'Sent for your review',
  APPROVAL_REQUESTED: 'Requested permission to send a verified update',
  APPROVAL_APPROVED: 'Owner approved the update',
  APPROVAL_REJECTED: 'Owner declined the update',
  CANCELLED: 'Work cancelled',
  RETRY_REQUESTED: 'Owner requested a recovery check',
  COMMERCE_QUOTE: 'Recorded the itemized quote',
  COMMERCE_INVOICE: 'Issued the invoice',
  COMMERCE_CASE: 'Recorded the customer case',
  COMMERCE_RESOLVED: 'Recorded verified completion',
  PICKUP_COMPLETED: 'Staff confirmed collection',
};
const reasons: Record<string, string> = {
  OWNER_STATUS_APPROVAL: 'Approve sending the customer a verified update about their order.',
  SUPPORT_EVIDENCE_UNAVAILABLE: 'FlowDesk could not verify the requested information.',
  INBOUND_REQUIRES_TEAM_REVIEW: 'The customer’s request needs a person to review it.',
  OUTBOUND_REQUIRES_REVIEW: 'Delivery of the message needs to be checked.',
  DEPENDENCY_DEADLINE_EXPIRED: 'The expected update did not arrive in time.',
  APPROVAL_EXPIRED: 'The approval window closed.',
  APPROVAL_STALE: 'Business records changed after this approval was requested.',
  BUSINESS_POLICY_CHANGED: 'Business settings changed while this was in progress.',
  CUSTOM_QUOTE_REVIEW: 'Review the customer’s specifications and quoted price.',
  QUOTE_AWAITS_ACCEPTANCE: 'The itemized quote is waiting for the customer’s decision.',
  AWAITING_INVOICE_BALANCE: 'A payment was verified. The remaining invoice balance is due.',
  COMMERCE_EVIDENCE_CHANGED: 'The current catalogue, stock, or quote terms require review.',
  ESCALATED_BY_OWNER: 'You moved this work to review.',
};
const profiles = {
  ONLINE_RETAIL: 'Online retailer', CUSTOM_ORDER: 'Custom orders', APPOINTMENT: 'Appointment business',
  PROFESSIONAL_SERVICES: 'Agency or professional service',
};
type Profile = keyof typeof profiles;
type Settings = { profile: Profile; enabled: boolean; supportMode: 'OWNER_REVIEW' | 'VERIFIED_STATUS'; revision: number };
type Workflow = {
  id: string; state: string; operator: string; revision: number; reason: string; updatedAt: string;
  customer: { name: string | null };
  actions: { approve: boolean; cancel: boolean; retry: boolean; escalate: boolean };
};
type Detail = Workflow & { orderId: string | null; appointmentId: string | null; order: { referenceNumber: string } | null;
  approval: { action: string; expiresAt: string; decision: string | null } | null;
  evidence: { id: string; eventType: string; createdAt: string }[] };
type Command = { path: 'decision' | 'cancel' | 'retry' | 'escalate'; approve?: boolean };

function Setup({ settings }: { settings: Settings | null }) {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState<Profile>(settings?.profile ?? 'ONLINE_RETAIL');
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [automatic, setAutomatic] = useState(settings?.supportMode === 'VERIFIED_STATUS');
  const save = useMutation({
    mutationFn: () => apiFetch('/workflow-settings', { method: 'PUT', body: {
      profile, enabled, supportMode: automatic ? 'VERIFIED_STATUS' : 'OWNER_REVIEW', revision: settings?.revision ?? 0,
    } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      void queryClient.invalidateQueries({ queryKey: ['business'] });
    },
  });
  return (
    <details className="px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">Workflow settings</summary>
      <form className="mt-3 grid gap-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <label className="grid gap-1 text-sm">
          Business profile
          <select className="max-w-xs rounded border bg-transparent p-2" value={profile}
            onChange={(event) => setProfile(event.target.value as Profile)}>
            {Object.entries(profiles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="text-sm"><input type="checkbox" checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)} /> Track new WhatsApp work</label>
        <label className="text-sm"><input type="checkbox" checked={automatic}
          onChange={(event) => setAutomatic(event.target.checked)} /> Send routine verified order updates automatically</label>
        {save.isError && <p role="alert" className="text-sm">{save.error.message}</p>}
        <div><Button type="submit" size="sm" disabled={save.isPending}>Save settings</Button></div>
      </form>
    </details>
  );
}

export default function WorkCenter(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const selected = params.get('work');
  const pageAfter = params.get('after');
  const specified = params.get('state') ?? '';
  const filter = Object.hasOwn(states, specified) ? specified : '';
  const select = (id: string | null) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (id) next.set('work', id); else next.delete('work');
    return next;
  });
  const client = useQueryClient();
  const rows = useQuery({
    queryKey: ['workflows', filter, pageAfter],
    queryFn: () => apiFetch<Workflow[]>('/workflows?' + new URLSearchParams({ ...(filter ? { state: filter } : {}),
      ...(pageAfter ? { afterId: pageAfter } : {}) })),
    refetchInterval: 5_000,
  });
  const settings = useQuery({
    queryKey: ['workflow-settings'],
    queryFn: () => apiFetch<{ settings: Settings | null }>('/workflow-settings'),
  });
  const detail = useQuery({
    queryKey: ['workflow', selected],
    queryFn: () => apiFetch<Detail>('/workflows/' + encodeURIComponent(selected!)),
    enabled: selected !== null,
    refetchInterval: 5_000,
  });
  const action = useMutation({
    mutationFn: (command: Command) => apiFetch('/workflows/' + encodeURIComponent(selected ?? '') + '/' + command.path, {
      method: 'POST', body: { revision: detail.data?.revision, ...(command.approve === undefined ? {} : { approve: command.approve }) },
    }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['workflows'] });
      void client.invalidateQueries({ queryKey: ['workflow', selected] });
    },
  });
  const current = detail.data;
  return (
    <Panel>
      <PanelHead title="Work center" />
      {settings.data && <Setup key={settings.data.settings?.revision ?? 0} settings={settings.data.settings} />}
      {settings.isError && <p role="alert" className="px-4 py-2 text-sm">Workflow settings could not be loaded.</p>}
      <label className="flex items-center gap-2 px-4 py-2 text-sm">
        Show
        <select className="rounded border bg-transparent p-1" value={filter}
          onChange={(event) => setParams((current) => {
            const next = new URLSearchParams(current);
            if (event.target.value) next.set('state', event.target.value); else next.delete('state');
            next.delete('work');
            next.delete('after');
            return next;
          })}>
          <option value="">Recent work</option>
          {Object.entries(states).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </label>
      {rows.isPending && <p className="px-4 py-3 text-sm">Loading work…</p>}
      {rows.isError && <p role="alert" className="px-4 py-3 text-sm">Work could not be loaded.</p>}
      {rows.data?.length === 0 && <p className="px-4 py-3 text-sm">No work in this view.</p>}
      <RowList>
        {rows.data?.map((row) => (
          <Row key={row.id}>
            <div className="min-w-0 text-sm">
              <p className="truncate font-medium">{row.customer.name ?? 'WhatsApp customer'}</p>
              <p className="text-text-muted">{operators[row.operator] ?? 'Customer request'} · {states[row.state] ?? 'Needs review'}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => { action.reset(); select(row.id); }}
              aria-expanded={selected === row.id}>View</Button>
          </Row>
        ))}
      </RowList>
      {(pageAfter || rows.data?.length === 50) && <div className="flex flex-wrap gap-2 px-4 py-3">
        {pageAfter && <Button size="sm" variant="secondary" onClick={() => setParams((current) => {
          const next = new URLSearchParams(current); next.delete('after'); return next;
        })}>Newest work</Button>}
        {rows.data?.length === 50 && <Button size="sm" variant="secondary" onClick={() => setParams((current) => {
          const next = new URLSearchParams(current); next.set('after', rows.data!.at(-1)!.id); return next;
        })}>Older work</Button>}
      </div>}
      {detail.isError && <p role="alert" className="px-4 py-3 text-sm">Work details could not be loaded.</p>}
      {current && (
        <section className="border-t px-4 py-3" aria-label="Work details">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{states[current.state]}</h3>
            <Button size="sm" variant="secondary" onClick={() => select(null)}>Close details</Button>
          </div>
          {current.order && current.orderId && <Link className="mt-2 block text-sm font-medium text-primary underline"
            to={'/orders?order=' + encodeURIComponent(current.orderId)}>{current.order.referenceNumber}</Link>}
          {current.appointmentId && <Link className="mt-2 block text-sm font-medium text-primary underline"
            to={'/bookings?view=operations&visit=' + encodeURIComponent(current.appointmentId)}>Open appointment</Link>}
          {current.approval?.action === 'SEND_VERIFIED_STATUS' && current.approval.decision === null && <p className="mt-2 text-sm">
            This action sends the customer a verified order status. Review the linked order before approving.
          </p>}
          {reasons[current.reason] && <p className="mt-2 text-sm">{reasons[current.reason]}</p>}
          <ol className="mt-3 grid gap-2 text-sm">
            {current.evidence.map((entry) => <li key={entry.id}>{steps[entry.eventType] ?? 'Recorded an update'} · {timeAgo(entry.createdAt)}</li>)}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            {current.actions.approve && <>
              <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ path: 'decision', approve: true })}>Approve reply</Button>
              <Button size="sm" variant="secondary" disabled={action.isPending}
                onClick={() => action.mutate({ path: 'decision', approve: false })}>Decline</Button>
            </>}
            {current.actions.retry && <Button size="sm" variant="secondary" disabled={action.isPending}
              onClick={() => action.mutate({ path: 'retry' })}>Check progress again</Button>}
            {current.actions.escalate && <Button size="sm" variant="secondary" disabled={action.isPending}
              onClick={() => action.mutate({ path: 'escalate' })}>Move to review</Button>}
            {current.actions.cancel && <Button size="sm" variant="secondary" disabled={action.isPending}
              onClick={() => action.mutate({ path: 'cancel' })}>Cancel work</Button>}
          </div>
          {action.isError && <p role="alert" className="mt-2 text-sm">{action.error.message}</p>}
        </section>
      )}
    </Panel>
  );
}
