import { useState } from 'react';
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
type Detail = Workflow & { order: { referenceNumber: string } | null; evidence: { id: string; eventType: string; createdAt: string }[] };
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
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['workflow-settings'] }); },
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
  const [selected, select] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const client = useQueryClient();
  const rows = useQuery({
    queryKey: ['workflows', filter],
    queryFn: () => apiFetch<Workflow[]>('/workflows' + (filter ? '?state=' + filter : '')),
    refetchInterval: 5_000,
  });
  const settings = useQuery({
    queryKey: ['workflow-settings'],
    queryFn: () => apiFetch<{ settings: Settings | null }>('/workflow-settings'),
  });
  const detail = useQuery({
    queryKey: ['workflow', selected],
    queryFn: () => apiFetch<Detail>('/workflows/' + selected),
    enabled: selected !== null,
    refetchInterval: 5_000,
  });
  const action = useMutation({
    mutationFn: (command: Command) => apiFetch('/workflows/' + selected + '/' + command.path, {
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
          onChange={(event) => { setFilter(event.target.value); select(null); }}>
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
      {detail.isError && <p role="alert" className="px-4 py-3 text-sm">Work details could not be loaded.</p>}
      {current && (
        <section className="border-t px-4 py-3" aria-label="Work details">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{states[current.state]}</h3>
            <Button size="sm" variant="secondary" onClick={() => select(null)}>Close details</Button>
          </div>
          {current.order && <p className="mt-2 text-sm font-medium">Order {current.order.referenceNumber}</p>}
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
