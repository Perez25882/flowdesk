import { cloneElement, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTabParam } from '@/hooks/useTabParam';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { InvoiceCheckout, type InvoiceCheckoutView } from '@/components/orders/InvoiceCheckout';
import { useCustomers } from '@/hooks/useCustomers';
import { apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

type Hours = { day: number; open: string; close: string }[];
type Settings = { enabled: boolean; timeZone: string; hours: Hours; closures: string[]; reminderMinutes: number | null;
  followupEnabled: boolean; templateName: string | null; templateLanguage: string | null; revision: number };
type Resource = { id: string; name: string; staffId: string | null; hours: Hours | null; closures: string[]; active: boolean };
type Rules = { category: string; prepMinutes: number; leadMinutes: number; advanceDays: number; holdMinutes: number;
  changeNoticeMinutes: number; noShowMinutes: number; maximumQuantity: number; approvalRequired: boolean;
  payment: { kind: string; percent?: number; amountMinor?: number }; staff: string[]; equipment: string[][];
  location: string; deliveryArea?: string; instructions: string; questions: string[]; stages: string[] };
type Service = { id: string; name: string; description: string | null; durationMinutes: number; bufferMinutes: number; capacity: number;
  price: string; active: boolean; bookingRules: Rules; bookingRevision: number };
type Lead = { id: string; customerId: string; serviceId: string | null; status: string; revision: number; requirements: string | null;
  assignedStaffId: string | null; followupAt: string | null; budgetMinor: number | null;
  supportCase?: { id: string; state: string } | null };
type Visit = { appointmentId: string; assignedStaffId: string | null; revision: number; stageIndex: number; state: string;
  customerId?: string; invoiceId?: string | null; paymentReviewAt?: string | null; holdUntil?: string | null; approvalRequired?: boolean; approvedAt?: string | null;
  appointment: { reference: string; startsAt: string; endsAt: string; customer: { name: string | null } };
  service: { name: string; timeZone: string; location: string; instructions: string; stages: string[] };
  history: { revision: number; action: string; evidence: string | null; createdAt: string }[];
  notices?: { kind: string; dueAt: string; reason: string | null; checkedAt: string | null; send: { state: string; reason: string | null } | null }[] };
type Staff = { id: string; name: string };
type Workbench = { visits: Visit[]; truncated?: boolean; settings?: Settings | null; resources?: Resource[]; services?: Service[]; leads?: Lead[]; staff?: Staff[];
  closedServiceRevenue?: string };
type Options = { serviceRevision: number; settingsRevision: number; slots: { startsAt: string; localTime: string }[];
  terms: { total: string; deposit: string; approvalRequired: boolean } };
type Save = (method: 'PUT' | 'POST' | 'PATCH', path: string, body: unknown) => Promise<void>;
const root = '/service-operations';
const control = 'min-w-0 rounded-md border border-border bg-surface px-2 py-2 text-sm';
const formGrid = 'grid gap-3 sm:grid-cols-2';
const padding = 'grid gap-3 p-4 text-sm';
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const status = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const value = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const number = (form: FormData, name: string) => Number(value(form, name));
const list = (text: string) => text.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
const displayDate = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(instant));
const calendarModes = ['list', 'day', 'week'] as const;
const calendarTabs = [{ value: 'list', label: 'List' }, { value: 'day', label: 'Day' }, { value: 'week', label: 'Seven days' }] as const;
const dayLength = 86_400_000;
function dateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map((part) => parts.find(({ type }) => type === part)?.value).join('-');
}

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="grid gap-1 min-w-0"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}

function Form({ children, submit, onSubmit }: { children: ReactNode; submit: string; onSubmit: (form: FormData) => Promise<void> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    const data = new FormData(event.currentTarget);
    setError('');
    setPending(true);
    try { await onSubmit(data); } catch (failure) { setError((failure as Error).message); } finally { submitting.current = false; setPending(false); }
  }
  return <form onSubmit={save} className="grid gap-3">
    {children}
    <Button type="submit" size="sm" disabled={pending} className="justify-self-start">{pending ? 'Saving…' : submit}</Button>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function OpeningHours({ current, optional }: { current: Hours; optional?: boolean }) {
  const [hours, setHours] = useState<Hours>(current);
  function update(day: number, index: number, key: 'open' | 'close', next: string) {
    setHours((items) => items.map((entry, position) => position === index ? { ...entry, day, [key]: next } : entry));
  }
  return <fieldset className="grid gap-2">
    <legend className="font-medium">{optional ? 'Resource hours override' : 'Opening hours'}</legend>
    {optional && <p>Leave empty to use business hours.</p>}
    <input type="hidden" name="hours" value={JSON.stringify(hours)} />
    {days.map((day, index) => <div key={day} className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-1">
      <span className="w-9">{day}</span>
      {hours.map((period, position) => period.day !== index ? null : <div key={position} className="flex items-center gap-1">
        <input type="time" aria-label={day + ' opens'} className={control} value={period.open} required
          onChange={(event) => update(index, position, 'open', event.target.value)} />
        <input type="time" aria-label={day + ' closes'} className={control} value={period.close} required
          onChange={(event) => update(index, position, 'close', event.target.value)} />
        <Button type="button" variant="ghost" size="sm" aria-label={'Remove ' + day + ' hours'}
          onClick={() => setHours((items) => items.filter((_, i) => i !== position))}>Remove</Button>
      </div>)}
      <Button type="button" variant="ghost" size="sm" onClick={() => setHours((items) => [...items, { day: index, open: '09:00', close: '17:00' }])}>
        Add {day} hours
      </Button>
    </div>)}
  </fieldset>;
}

function CalendarSettings({ settings, save }: { settings: Settings | null; save: Save }) {
  return <details open={!settings}><summary className="cursor-pointer font-medium">Business hours and reminders</summary>
    <div className="pt-3"><Form submit="Save business hours" onSubmit={(data) => save('PUT', '/settings', {
      enabled: data.has('enabled'), revision: settings?.revision ?? 0, timeZone: value(data, 'zone'),
      hours: JSON.parse(value(data, 'hours')), closures: list(value(data, 'closures')), reminderMinutes: number(data, 'reminder') || null,
      followupEnabled: data.has('followup'), templateName: value(data, 'template') || null, templateLanguage: value(data, 'language') || null,
    })}>
      <label><input name="enabled" type="checkbox" defaultChecked={settings?.enabled ?? true} /> Enable service operations</label>
      <Field label="Business time zone"><input name="zone" className={control} required defaultValue={settings?.timeZone ?? 'Africa/Accra'} /></Field>
      <OpeningHours current={settings?.hours ?? days.slice(1, 6).map((_, index) => ({ day: index + 1, open: '09:00', close: '17:00' }))} />
      <div className={formGrid}>
        <Field label="Closures (YYYY-MM-DD, comma separated)"><input name="closures" className={control} defaultValue={settings?.closures.join(', ')} /></Field>
        <Field label="Reminder minutes before appointment"><input name="reminder" type="number" min={15} max={2880} className={control}
          defaultValue={settings?.reminderMinutes ?? ''} /></Field>
        <Field label="Approved WhatsApp service template"><input name="template" className={control} defaultValue={settings?.templateName ?? ''} /></Field>
        <Field label="Template language"><input name="language" className={control} defaultValue={settings?.templateLanguage ?? ''} /></Field>
      </div>
      <label><input name="followup" type="checkbox" defaultChecked={settings?.followupEnabled} /> Allow opt-in service follow-ups</label>
    </Form></div>
  </details>;
}

function ResourceForm({ resource, staff, save }: { resource?: Resource; staff: Staff[]; save: Save }) {
  return <details><summary className="cursor-pointer">{resource?.name ?? 'Add staff or equipment'}</summary>
    <div className="pt-3"><Form submit="Save resource" onSubmit={(data) => {
      const hours = JSON.parse(value(data, 'hours')) as Hours;
      return save(resource ? 'PUT' : 'POST', '/resources' + (resource ? '/' + resource.id : ''), {
        name: value(data, 'name'), staffId: resource ? resource.staffId : value(data, 'staff') || null,
        hours: hours.length ? hours : null, closures: list(value(data, 'closures')), active: data.has('active'),
      });
    }}>
      <div className={formGrid}>
        <Field label="Resource name"><input name="name" className={control} required defaultValue={resource?.name} /></Field>
        <Field label="Staff member"><select name="staff" className={control} disabled={Boolean(resource)} defaultValue={resource?.staffId ?? ''}>
          <option value="">Equipment or room</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select></Field>
      </div>
      <OpeningHours current={resource?.hours ?? []} optional />
      <Field label="Resource closures (YYYY-MM-DD, comma separated)"><input name="closures" className={control}
        defaultValue={resource?.closures.join(', ')} /></Field>
      <label><input name="active" type="checkbox" defaultChecked={resource?.active ?? true} /> Available for booking</label>
    </Form></div>
  </details>;
}

function CatalogueForm({ service, resources, save }: { service?: Service; resources: Resource[]; save: Save }) {
  const rules = service?.bookingRules;
  const [payment, setPayment] = useState(rules?.payment.kind ?? 'AFTER_SERVICE');
  return <details><summary className="cursor-pointer">{service?.name ?? 'Add a managed service'}</summary>
    <div className="pt-3"><Form submit="Save service" onSubmit={(data) => save(service ? 'PUT' : 'POST',
      '/catalogue' + (service ? '/' + service.id : ''), {
        revision: service?.bookingRevision ?? 0, name: value(data, 'name'), description: value(data, 'description'),
        durationMinutes: number(data, 'duration'), bufferMinutes: number(data, 'buffer'), capacity: number(data, 'capacity'),
        priceMinor: Math.round(number(data, 'price') * 100), active: data.has('active'),
        rules: { category: value(data, 'category'), prepMinutes: number(data, 'prep'), leadMinutes: number(data, 'lead'),
          advanceDays: number(data, 'advance'), holdMinutes: number(data, 'hold'), maximumQuantity: number(data, 'quantity'),
          changeNoticeMinutes: number(data, 'changes'), noShowMinutes: number(data, 'noshow'), approvalRequired: data.has('approval'),
          payment: { kind: payment, ...(payment === 'FIXED' ? { amountMinor: Math.round(number(data, 'deposit') * 100) } : {}),
            ...(payment === 'PERCENT' ? { percent: number(data, 'deposit') } : {}) },
          staff: data.getAll('eligible').map(String), equipment: [0, 1, 2, 3].map((index) => data.getAll('equipment-' + index).map(String)).filter((group) => group.length),
          location: value(data, 'location'), ...(value(data, 'area') ? { deliveryArea: value(data, 'area') } : {}),
          instructions: value(data, 'instructions'), questions: list(value(data, 'questions')), stages: list(value(data, 'stages')),
        },
      })}>
      <div className={formGrid}>
        <Field label="Service name"><input name="name" className={control} required defaultValue={service?.name} /></Field>
        <Field label="Service category"><select name="category" className={control} defaultValue={rules?.category ?? 'PERSONAL'}>
          <option value="PERSONAL">Personal appointment</option><option value="CONSULTATION">Consultation</option>
          <option value="REPAIR">Repair and stages</option><option value="STAFF_ASSIGNED">Staff assigned</option>
        </select></Field>
        <Field label="Description"><input name="description" className={control} defaultValue={service?.description ?? ''} /></Field>
        <Field label="Service location"><input name="location" className={control} required defaultValue={rules?.location} /></Field>
        <Field label="Off-site service area"><input name="area" className={control} defaultValue={rules?.deliveryArea} /></Field>
        <Field label="Price (GHS)"><input name="price" type="number" min={0} step="0.01" className={control} required defaultValue={service?.price ?? '0'} /></Field>
        {[
          ['duration', 'Duration minutes', 30, 5, 480, service?.durationMinutes],
          ['prep', 'Preparation minutes', 0, 0, 120, rules?.prepMinutes], ['buffer', 'Cleanup minutes', 0, 0, 120, service?.bufferMinutes],
          ['capacity', 'Parallel capacity', 1, 1, 12, service?.capacity], ['quantity', 'Maximum quantity', 1, 1, 8, rules?.maximumQuantity],
          ['lead', 'Minimum notice minutes', 60, 0, 10080, rules?.leadMinutes], ['advance', 'Advance booking days', 30, 1, 90, rules?.advanceDays],
          ['hold', 'Hold expiry minutes', 30, 5, 60, rules?.holdMinutes], ['changes', 'Change notice minutes', 120, 0, 10080, rules?.changeNoticeMinutes],
          ['noshow', 'No-show grace minutes', 15, 5, 180, rules?.noShowMinutes],
        ].map(([name, label, fallback, min, max, existing]) => <Field key={String(name)} label={String(label)}>
          <input name={String(name)} className={control} type="number" min={min} max={max} required defaultValue={existing ?? fallback} />
        </Field>)}
        <Field label="Payment policy"><select className={control} value={payment} onChange={(event) => setPayment(event.target.value)}>
          <option value="AFTER_SERVICE">Pay after service</option><option value="FULL">Full payment before confirmation</option>
          <option value="FIXED">Fixed deposit</option><option value="PERCENT">Percentage deposit</option>
        </select></Field>
        {['FIXED', 'PERCENT'].includes(payment) && <Field label={payment === 'FIXED' ? 'Deposit (GHS)' : 'Deposit percentage'}>
          <input key={payment} name="deposit" className={control} type="number" min={1} step={payment === 'FIXED' ? '0.01' : '1'} required
            defaultValue={payment === 'FIXED' && rules?.payment.amountMinor ? rules.payment.amountMinor / 100 : rules?.payment.percent} />
        </Field>}
      </div>
      <fieldset><legend>Eligible staff</legend><div className="flex flex-wrap gap-3">
        {resources.filter((resource) => resource.staffId && (resource.active || rules?.staff.includes(resource.id))).map((resource) =>
          <label key={resource.id}><input name="eligible" value={resource.id} type="checkbox" defaultChecked={rules?.staff.includes(resource.id)} /> {resource.name}</label>)}
      </div></fieldset>
      {resources.some((resource) => !resource.staffId) && <details><summary>Required equipment alternatives</summary>
        <p>The appointment requires one resource from each selected group.</p>
        {[0, 1, 2, 3].map((index) => <fieldset key={index}><legend>Equipment group {index + 1}</legend>
          <div className="flex flex-wrap gap-3">{resources.filter((resource) => !resource.staffId && (resource.active || rules?.equipment[index]?.includes(resource.id)))
            .map((resource) => <label key={resource.id}><input name={'equipment-' + index} value={resource.id} type="checkbox"
              defaultChecked={rules?.equipment[index]?.includes(resource.id)} /> {resource.name}</label>)}</div>
        </fieldset>)}</details>}
      <Field label="Customer instructions"><textarea name="instructions" className={control} defaultValue={rules?.instructions} /></Field>
      <Field label="Qualification questions (one per line)"><textarea name="questions" className={control} defaultValue={rules?.questions.join('\n')} /></Field>
      <Field label="Execution stages (one per line)"><textarea name="stages" className={control} defaultValue={rules?.stages.join('\n')} /></Field>
      <label><input name="approval" type="checkbox" defaultChecked={rules?.approvalRequired} /> Require manager approval</label>
      <label><input name="active" type="checkbox" defaultChecked={service?.active ?? true} /> Available for booking</label>
    </Form></div>
  </details>;
}

function VisitInvoice({ id }: { id: string }) {
  const invoice = useQuery({
    queryKey: ['service-operations', 'invoice', id], queryFn: () => apiFetch<InvoiceCheckoutView & { reference: string; total: string; due: string; verified: string; deposit: string }>(
      '/commerce/invoices/' + id), refetchInterval: 5_000,
  });
  return <section aria-label="Service invoice" className="grid gap-2 pt-2">
    {invoice.isPending && <p role="status">Loading invoice…</p>}
    {invoice.isError && <button onClick={() => void invoice.refetch()} className="justify-self-start text-primary underline">Retry invoice</button>}
    {invoice.data && <>
      <p>{invoice.data.reference} · {status(invoice.data.state)}</p>
      <p>Total {formatCurrency(Number(invoice.data.total))} · Deposit {formatCurrency(Number(invoice.data.deposit))}</p>
      <p>Verified {formatCurrency(Number(invoice.data.verified))} · Due {formatCurrency(Number(invoice.data.due))}</p>
      <InvoiceCheckout invoice={invoice.data} onChange={() => void invoice.refetch()} />
    </>}
  </section>;
}

const visitActions: Record<string, string[]> = {
  HELD: ['APPROVE', 'CANCEL'], CONFIRMED: ['ACKNOWLEDGE', 'CHECK_IN', 'REASSIGN', 'RESCHEDULE', 'CANCEL', 'NO_SHOW'],
  ACKNOWLEDGED: ['CHECK_IN', 'REASSIGN', 'RESCHEDULE', 'CANCEL', 'NO_SHOW'], CHECKED_IN: ['START', 'CANCEL'],
  IN_PROGRESS: ['STAGE', 'BLOCK', 'COMPLETE', 'CANCEL'], BLOCKED: ['RESUME', 'CANCEL'], COMPLETED: ['FOLLOW_UP'],
};
const managerActions = new Set(['APPROVE', 'REASSIGN', 'RESCHEDULE', 'CANCEL', 'NO_SHOW', 'FOLLOW_UP']);
function AppointmentCard({ visit, manager, staff, save }: { visit: Visit; manager: boolean; staff: Staff[]; save: Save }) {
  const [action, setAction] = useState('');
  const actions = (visitActions[visit.state] ?? []).filter((entry) => (manager || !managerActions.has(entry)) &&
    (entry !== 'APPROVE' || visit.approvalRequired && !visit.approvedAt) &&
    (entry !== 'STAGE' || visit.stageIndex < visit.service.stages.length) &&
    (entry !== 'COMPLETE' || visit.stageIndex >= visit.service.stages.length));
  return <li className="grid gap-2 border-b border-border-subtle py-2">
    <strong>{visit.service.name} · {visit.appointment.customer.name ?? 'Customer'}</strong>
    <p>{displayDate(visit.appointment.startsAt, visit.service.timeZone)} ({visit.service.timeZone}) · {status(visit.state)}</p>
    <p>{visit.appointment.reference} · {visit.service.location}</p>
    {visit.service.instructions && <p>{visit.service.instructions}</p>}
    {manager && visit.assignedStaffId && <p>Assigned to {staff.find((person) => person.id === visit.assignedStaffId)?.name ?? 'Unavailable staff'}</p>}
    {visit.holdUntil && <p>Hold expires {displayDate(visit.holdUntil, visit.service.timeZone)}</p>}
    {visit.paymentReviewAt && <p role="status">Payment requires review.</p>}
    {visit.invoiceId && <details><summary className="cursor-pointer">View invoice and deposit</summary><VisitInvoice id={visit.invoiceId} /></details>}
    {actions.length > 0 && <Form key={visit.revision} submit="Record appointment action" onSubmit={async (data) => {
      await save('POST', '/visits/' + visit.appointmentId + '/actions', { action, revision: visit.revision, evidence: value(data, 'evidence'),
        ...(action === 'RESCHEDULE' ? { startsAt: value(data, 'startsAt') } : {}), ...(action === 'REASSIGN' ? { staffId: value(data, 'staff') } : {}) });
      setAction('');
    }}>
      <Field label="Appointment action"><select className={control} value={action} required onChange={(event) => setAction(event.target.value)}>
        <option value="">Choose an action</option>{actions.map((entry) => <option key={entry} value={entry}>
          {entry === 'STAGE' ? 'Record ' + visit.service.stages[visit.stageIndex] : status(entry)}
        </option>)}
      </select></Field>
      {action === 'RESCHEDULE' && <Field label="New time (ISO 8601 with offset)"><input name="startsAt" className={control} required
        placeholder="2026-11-21T10:00:00Z" /></Field>}
      {action === 'REASSIGN' && <Field label="New staff member"><select name="staff" className={control} required>
        <option value="">Choose staff</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select></Field>}
      {action && <Field label="Evidence or staff notes"><textarea name="evidence" className={control} minLength={3} maxLength={600} required /></Field>}
    </Form>}
    <details><summary className="cursor-pointer">Appointment history</summary><ol className="grid gap-1 pt-1">
      {visit.history.map((event) => <li key={event.revision}>{displayDate(event.createdAt, visit.service.timeZone)} · {status(event.action)}
        {event.evidence && ' · ' + event.evidence}</li>)}
    </ol></details>
    {Boolean(visit.notices?.length) && <details><summary className="cursor-pointer">Notifications</summary>
      <ul>{visit.notices?.map((notice, index) => <li key={index}>{status(notice.kind)} · {status(notice.send?.state ?? notice.reason ?? 'scheduled')}
        {notice.send?.reason && ' · ' + status(notice.send.reason)}</li>)}</ul>
    </details>}
  </li>;
}

function BookingForm({ services, leads, save }: { services: Service[]; leads: Lead[]; save: Save }) {
  const [params, setParams] = useSearchParams();
  const attempted = params.get('reserve');
  const customers = useCustomers();
  const [serviceId, setService] = useState('');
  const [leadId, setLead] = useState('');
  const [customerId, setCustomer] = useState('');
  const [from, setFrom] = useState('');
  const [quantity, setQuantity] = useState(1);
  const selected = services.find((service) => service.id === serviceId);
  const [selection, select] = useState<{ key: string; startsAt: string } | null>(null);
  const saved = useQuery({ queryKey: ['service-operations', 'reservation', attempted],
    enabled: Boolean(attempted && /^[\da-f-]{36}$/i.test(attempted)),
    queryFn: () => apiFetch<{ appointmentId: string } | null>(root + '/reservations/' + encodeURIComponent(attempted ?? '')) });
  const slots = useMutation({ mutationFn: () => apiFetch<Options>(root + '/slots?' + new URLSearchParams({
    serviceId, quantity: String(quantity), from: from ? new Date(from + 'T00:00:00Z').toISOString() : new Date().toISOString(),
  })) });
  function requestKey(key: string | null): void {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (key) next.set('reserve', key); else next.delete('reserve');
      return next;
    }, { replace: true });
  }
  function reset() { slots.reset(); select(null); requestKey(null); }
  if (saved.data) return <div role="status" className="grid gap-2">
    <p>Your appointment was saved.</p>
    <Link className="text-primary underline" to={'/bookings?view=operations&visit=' + encodeURIComponent(saved.data.appointmentId)}>Open saved appointment</Link>
    <Button size="sm" variant="secondary" className="justify-self-start" onClick={reset}>Start another reservation</Button>
  </div>;
  return <Form submit="Reserve appointment" onSubmit={async (data) => {
    if (!selection || !slots.data) throw new Error('Find current times and choose an appointment.');
    await save('POST', '/visits', { serviceId, customerId, startsAt: selection.startsAt, quantity, requestKey: selection.key,
      ...(leadId ? { leadId } : {}), ...(value(data, 'location') ? { location: value(data, 'location') } : {}),
      serviceRevision: slots.data.serviceRevision, settingsRevision: slots.data.settingsRevision }).catch(async (error: unknown) => {
      await saved.refetch();
      throw error;
    });
    reset();
  }}>
    <div className={formGrid}>
      <Field label="Qualified lead"><select className={control} value={leadId} onChange={(event) => {
        const lead = leads.find((item) => item.id === event.target.value);
        setLead(event.target.value); setService(lead?.serviceId ?? ''); setCustomer(lead?.customerId ?? ''); setQuantity(1); reset();
      }}><option value="">Direct booking</option>{leads.filter((lead) => lead.status === 'QUALIFIED').map((lead) =>
        <option value={lead.id} key={lead.id}>{lead.requirements || lead.id}</option>)}</select></Field>
      <Field label="Customer"><select className={control} required value={customerId} disabled={Boolean(leadId)} onChange={(event) => setCustomer(event.target.value)}>
        <option value="">Choose customer</option>{customers.data?.map((customer) =>
          <option value={customer.id} key={customer.id}>{customer.name ?? customer.waNumber}</option>)}</select></Field>
      <Field label="Service to book"><select className={control} required value={serviceId} disabled={Boolean(leadId)}
        onChange={(event) => { setService(event.target.value); setQuantity(1); reset(); }}>
        <option value="">Choose service</option>{services.filter((service) => service.active).map((service) =>
          <option value={service.id} key={service.id}>{service.name}</option>)}</select></Field>
      <Field label="Find times from (UTC date)"><input type="date" className={control} value={from} onChange={(event) => { setFrom(event.target.value); reset(); }} /></Field>
      <Field label="Quantity"><input type="number" className={control} min={1} max={selected?.bookingRules.maximumQuantity ?? 1} value={quantity}
        onChange={(event) => { setQuantity(Number(event.target.value)); reset(); }} /></Field>
    </div>
    {selected?.bookingRules.deliveryArea && <Field label={'Customer-confirmed location in ' + selected.bookingRules.deliveryArea}>
      <input name="location" className={control} required /></Field>}
    <Button type="button" size="sm" variant="secondary" className="justify-self-start" disabled={!serviceId || slots.isPending}
      onClick={() => { select(null); slots.mutate(); }}>Find available times</Button>
    {slots.isError && <p role="alert">{slots.error.message}</p>}
    {slots.data && <p>Quote {formatCurrency(Number(slots.data.terms.total))} · Deposit {formatCurrency(Number(slots.data.terms.deposit))}
      {slots.data.terms.approvalRequired ? ' · Manager approval required' : ''}</p>}
    {slots.data?.slots.length === 0 && <p role="status">No matching times found. Try a different date.</p>}
    {Boolean(slots.data?.slots.length) && <Field label="Available times"><select className={control} required value={selection?.startsAt ?? ''}
      onChange={(event) => {
        const chosen = event.target.value ? { startsAt: event.target.value, key: crypto.randomUUID() } : null;
        select(chosen);
        requestKey(chosen?.key ?? null);
      }}>
      <option value="">Choose time</option>{slots.data?.slots.map((slot) => <option key={slot.startsAt} value={slot.startsAt}>{slot.localTime} · {slot.startsAt.slice(11, 16)} UTC</option>)}
    </select></Field>}
  </Form>;
}

function LeadForm({ services, save }: { services: Service[]; save: Save }) {
  const customers = useCustomers();
  return <details><summary className="cursor-pointer">Add a service inquiry</summary><div className="pt-2">
    <Form submit="Save inquiry" onSubmit={(data) => save('POST', '/leads', {
      customerId: value(data, 'customer'), requirements: value(data, 'requirements'),
      ...(value(data, 'service') ? { serviceId: value(data, 'service') } : {}),
      ...(value(data, 'budget') ? { budgetMinor: Math.round(number(data, 'budget') * 100) } : {}),
      ...(value(data, 'preferred') ? { preferredAt: new Date(value(data, 'preferred')).toISOString() } : {}),
    })}>
      <Field label="Inquiry customer"><select name="customer" className={control} required>
        <option value="">Choose customer</option>{customers.data?.map((customer) =>
          <option key={customer.id} value={customer.id}>{customer.name ?? customer.waNumber}</option>)}</select></Field>
      <Field label="Inquiry service"><select name="service" className={control}>
        <option value="">Service to be determined</option>{services.filter((service) => service.active).map((service) =>
          <option key={service.id} value={service.id}>{service.name}</option>)}</select></Field>
      <Field label="Customer requirements"><textarea name="requirements" className={control} maxLength={600} required /></Field>
      <Field label="Budget (GHS)"><input name="budget" type="number" min={0} step="0.01" className={control} /></Field>
      <Field label="Preferred time (device time)"><input name="preferred" type="datetime-local" className={control} /></Field>
    </Form>
  </div></details>;
}

export default function ServiceOperations({ manager }: { manager: boolean }): React.JSX.Element {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [calendar, setCalendar] = useTabParam('calendar', calendarModes, 'list');
  const [date, setDate] = useState('');
  const visitId = params.get('visit');
  const base = useQuery({ queryKey: ['service-operations', 'workbench', manager], queryFn: () => apiFetch<Workbench>(root), refetchInterval: 20_000 });
  const timeZone = base.data?.settings?.timeZone ?? base.data?.visits[0]?.service.timeZone ?? 'Africa/Accra';
  const firstDay = date || dateInZone(new Date(), timeZone);
  const start = Date.parse(firstDay + 'T00:00:00Z');
  const end = start + (calendar === 'week' ? 7 : 1) * dayLength;
  const lastDay = new Date(end).toISOString().slice(0, 10);
  const range = visitId ? new URLSearchParams({ visit: visitId }).toString()
    : calendar !== 'list' ? new URLSearchParams({ from: new Date(start - dayLength).toISOString(), until: new Date(end + dayLength).toISOString() }).toString() : '';
  const filtered = useQuery({ queryKey: ['service-operations', 'visit-list', range], enabled: Boolean(range && base.data),
    queryFn: () => apiFetch<Workbench>(root + '?' + range) });
  const mutation = useMutation({
    mutationFn: ({ method, path, body }: { method: Parameters<Save>[0]; path: string; body: unknown }) =>
      apiFetch(root + path, { method, body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['service-operations'] }),
  });
  const save: Save = async (method, path, body) => { await mutation.mutateAsync({ method, path, body }); };
  if (base.isPending) return <p role="status">Loading service operations…</p>;
  if (!base.data) return <div role="alert"><p>Service operations could not load.</p><Button onClick={() => void base.refetch()}>Retry</Button></div>;
  const { settings, services = [], resources = [], staff = [], leads = [], closedServiceRevenue } = base.data;
  const source = range ? filtered.data : base.data;
  const visits = source?.visits.filter((visit) => {
    if (visitId || calendar === 'list') return true;
    const local = dateInZone(new Date(visit.appointment.startsAt), timeZone);
    return local >= firstDay && local < lastDay;
  });
  return <div className="grid gap-4">
    {manager && <div id="service-setup"><Panel><PanelHead title="Service setup" /><div className={padding}>
      <CalendarSettings key={settings?.revision ?? 0} settings={settings ?? null} save={save} />
      {settings && <>
        {resources.map((resource) => <ResourceForm key={resource.id} resource={resource} staff={staff} save={save} />)}
        <ResourceForm staff={staff} save={save} />
        {services.map((service) => <CatalogueForm key={service.id + ':' + service.bookingRevision} service={service} resources={resources} save={save} />)}
        <CatalogueForm resources={resources} save={save} />
      </>}
    </div></Panel></div>}
    {manager && settings?.enabled && <>
      <Panel><PanelHead title="Service leads" /><div className={padding}>
        <LeadForm services={services} save={save} />
        {leads.length === 0 && <p>Service inquiries will appear here.</p>}
        {leads.map((lead) => <details key={lead.id}><summary className="cursor-pointer">{lead.requirements || 'Service inquiry'} · {status(lead.status)}</summary>
          <div className="grid gap-2 pl-2 pt-2">
            {lead.budgetMinor !== null && <p>Budget {formatCurrency(lead.budgetMinor / 100)}</p>}
            {lead.followupAt && <p>Follow up {displayDate(lead.followupAt, settings.timeZone)}</p>}
            {lead.supportCase && <Link to={'/messages?view=cases&case=' + encodeURIComponent(lead.supportCase.id)} className="text-primary underline">
              Open case · {status(lead.supportCase.state)}</Link>}
            {['NEW', 'WAITING', 'QUALIFIED'].includes(lead.status) && <Form key={lead.revision} submit="Save qualification" onSubmit={(data) =>
              save('PATCH', '/leads/' + lead.id, { revision: lead.revision, status: value(data, 'status'),
                ...(value(data, 'service') ? { serviceId: value(data, 'service') } : {}), assignedStaffId: value(data, 'staff') || null,
                evidence: value(data, 'evidence'), followupAt: value(data, 'followup') ? new Date(value(data, 'followup')).toISOString() : null })}>
              <Field label="Lead status"><select name="status" className={control} defaultValue={lead.status === 'NEW' ? 'QUALIFIED' : lead.status}>
                {['QUALIFIED', 'WAITING', 'LOST', 'DECLINED', 'UNQUALIFIED'].map((entry) => <option key={entry} value={entry}>{status(entry)}</option>)}
              </select></Field>
              <Field label="Requested service"><select name="service" className={control} defaultValue={lead.serviceId ?? ''}>
                <option value="">Choose service</option>{services.filter((service) => service.active).map((service) =>
                  <option value={service.id} key={service.id}>{service.name}</option>)}</select></Field>
              <Field label="Responsible staff"><select name="staff" className={control} defaultValue={lead.assignedStaffId ?? ''}>
                <option value="">Unassigned</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
              <Field label="Qualification notes"><textarea name="evidence" className={control} minLength={3} required /></Field>
              <Field label="Follow-up time (device time)"><input type="datetime-local" name="followup" className={control} /></Field>
            </Form>}
          </div>
        </details>)}
      </div></Panel>
      <Panel><PanelHead title="Reserve a service" /><div className={padding}><BookingForm services={services} leads={leads} save={save} /></div></Panel>
    </>}
    <Panel><PanelHead title={manager ? 'Service appointments' : 'Assigned appointments'} />
      <div className="grid gap-2 px-4">
        {visitId ? <Button size="sm" variant="secondary" className="justify-self-start" onClick={() => setParams((previous) => {
          const next = new URLSearchParams(previous); next.delete('visit'); return next;
        })}>Show all appointments</Button> : <>
          <Tabs label="Calendar view" options={calendarTabs} value={calendar} onChange={setCalendar} />
          {calendar !== 'list' && <label className="text-sm">Starting date ({timeZone}) <input className={control} type="date" value={firstDay}
            onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>}
        </>}
        {range && filtered.isPending && <p role="status">Loading appointments…</p>}
        {range && filtered.isError && <p role="alert">The requested appointments are unavailable.{' '}
          <button className="underline" onClick={() => void filtered.refetch()}>Try again</button></p>}
        {source?.truncated && <p className="text-sm text-text-secondary">Showing up to 100 appointments. Choose a day to narrow the results.</p>}
      </div>
      {closedServiceRevenue && <p className="px-4 pt-3 text-sm">Verified receipts for completed services {formatCurrency(Number(closedServiceRevenue))}</p>}
      <ul className={padding}>{visits?.length === 0 ? <li>No service appointments in this view.</li> : visits?.map((visit) =>
        <AppointmentCard key={visit.appointmentId} visit={visit} manager={manager} staff={staff} save={save} />)}</ul>
    </Panel>
  </div>;
}
