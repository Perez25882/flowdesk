import { useMemo, useState } from 'react';
import { CalendarDays, Check, Clock, Plus, Trash2, UserX, X } from 'lucide-react';
import {
  useAppointments,
  useCreateService,
  useDeleteService,
  useServices,
  useSetAppointmentStatus,
  useSlots,
  type Appointment,
  type Service,
} from '@/hooks/useBookings';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { cn, formatCurrency } from '@/lib/utils';

const EMPTY_SERVICE = {
  name: '',
  durationMinutes: '30',
  bufferMinutes: '0',
  capacity: '1',
  price: '',
};

type Tab = 'diary' | 'services';

/**
 * The diary, and the things that can be booked into it.
 *
 * Built for clinics, schools and professional services, businesses that sell
 * time rather than stock, and which often have no product catalogue at all.
 * That is why services are their own thing and not a flag on a product: a
 * consultation has a duration and a calendar, not a shelf and a reorder level.
 *
 * Times are shown in the shop's own wall clock, which for Ghana is UTC. Every
 * formatter on this page pins the timezone explicitly rather than trusting the
 * browser, because an owner travelling, or a laptop with the wrong zone set , 
 * must not see a diary shifted by an hour.
 */
export default function BookingsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('diary');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_SERVICE);
  const [previewServiceId, setPreviewServiceId] = useState<string | null>(null);

  const { data: services, isLoading: loadingServices } = useServices();
  const { data: appointments, isLoading: loadingDiary } = useAppointments();
  const createService = useCreateService();
  const deleteService = useDeleteService();
  const setStatus = useSetAppointmentStatus();

  const upcoming = useMemo(
    () =>
      (appointments ?? []).filter(
        (appointment) => appointment.status === 'BOOKED' || appointment.status === 'CONFIRMED',
      ),
    [appointments],
  );

  const byDay = useMemo(() => groupByDay(upcoming), [upcoming]);

  function handleCreateService(): void {
    createService.mutate(
      {
        name: form.name.trim(),
        durationMinutes: Number(form.durationMinutes) || 30,
        bufferMinutes: Number(form.bufferMinutes) || 0,
        capacity: Number(form.capacity) || 1,
        price: form.price.trim() ? Number(form.price) : null,
      },
      {
        onSuccess: () => {
          setForm(EMPTY_SERVICE);
          setShowForm(false);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Bookings"
        description="What you offer, and who is coming in."
        actions={
          tab === 'services' ? (
            <Button
              size="sm"
              onClick={() => setShowForm((open) => !open)}
              leadingIcon={<Plus className="h-4 w-4" strokeWidth={2} />}
            >
              Add a service
            </Button>
          ) : null
        }
      />

      <span className="flex items-center gap-1 border-b border-border" role="tablist">
        {(
          [
            ['diary', 'Diary'],
            ['services', 'What you offer'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === value
                ? 'border-primary font-medium text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
          >
            {label}
          </button>
        ))}
      </span>

      {tab === 'diary' && (
        <>
          {loadingDiary && (
            <Panel>
              <SkeletonRows count={5} />
            </Panel>
          )}

          {!loadingDiary && upcoming.length === 0 && (
            <Panel>
              <EmptyState
                icon={CalendarDays}
                title="Nothing booked"
                description={
                  (services?.length ?? 0) === 0
                    ? 'Add a service first, then Flowdesk can take bookings for it.'
                    : 'Appointments appear here as they are booked, by you or by the assistant.'
                }
              />
            </Panel>
          )}

          {byDay.map(([day, items]) => (
            <Panel key={day}>
              <PanelHead
                title={formatDay(items[0]!.startsAt)}
                meta={`${items.length} appointment${items.length === 1 ? '' : 's'}`}
              />
              <ul className="divide-y divide-border-subtle">
                {items.map((appointment) => (
                  <li key={appointment.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="fd-figure w-16 shrink-0 text-sm font-medium text-text-primary">
                      {formatTime(appointment.startsAt)}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">
                        {appointment.customer.name || appointment.customer.waNumber}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {appointment.service.name}
                        {' · '}
                        {minutesBetween(appointment.startsAt, appointment.endsAt)} min
                        {/* Only worth saying when there is more than one chair;
                            on a single-resource service it is always "1 of 1". */}
                        {appointment.service.capacity > 1 &&
                          ` · #${appointment.resourceIndex + 1}`}
                        {appointment.bookedByAssistant && ' · booked by Flowdesk'}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-1">
                      <IconButton
                        label={`Mark ${appointment.reference} as done`}
                        onClick={() =>
                          setStatus.mutate({ id: appointment.id, status: 'COMPLETED' })
                        }
                      >
                        <Check className="h-4 w-4" strokeWidth={2} />
                      </IconButton>
                      <IconButton
                        label={`Mark ${appointment.reference} as a no-show`}
                        onClick={() => setStatus.mutate({ id: appointment.id, status: 'NO_SHOW' })}
                      >
                        <UserX className="h-4 w-4" strokeWidth={2} />
                      </IconButton>
                      <IconButton
                        label={`Cancel ${appointment.reference}`}
                        danger
                        onClick={() =>
                          setStatus.mutate({ id: appointment.id, status: 'CANCELLED' })
                        }
                      >
                        <X className="h-4 w-4" strokeWidth={2} />
                      </IconButton>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </>
      )}

      {tab === 'services' && (
        <>
          {showForm && (
            <Panel>
              <PanelHead title="A new service" />
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-sm font-medium text-text-primary">Name</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Consultation"
                    className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-text-primary">Takes (min)</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={5}
                    value={form.durationMinutes}
                    onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                    className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-text-primary">Gap after (min)</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.bufferMinutes}
                    onChange={(e) => setForm({ ...form, bufferMinutes: e.target.value })}
                    className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                  />
                  <span className="text-xs text-text-muted">Held in the diary, not shown to the customer.</span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-text-primary">At once</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                  />
                  <span className="text-xs text-text-muted">Chairs, rooms or people.</span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-text-primary">Price</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    placeholder="Optional"
                    className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                  />
                  <span className="text-xs text-text-muted">Quoted only. Nothing is collected on a booking.</span>
                </label>

                <span className="flex items-center gap-2 lg:col-span-5">
                  <Button
                    size="sm"
                    onClick={handleCreateService}
                    disabled={form.name.trim().length === 0}
                    isLoading={createService.isPending}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                </span>
              </div>
            </Panel>
          )}

          <Panel>
            <PanelHead title="What you offer" meta={`${services?.length ?? 0}`} />

            {loadingServices && <SkeletonRows count={3} />}

            {!loadingServices && (services?.length ?? 0) === 0 && (
              <EmptyState
                icon={Clock}
                title="No services yet"
                description="A service is something you do at a time: a consultation, a class, a fitting. Add one and Flowdesk can start taking bookings for it."
              />
            )}

            <ul className="divide-y divide-border-subtle">
              {(services ?? []).map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewServiceId((current) => (current === row.id ? null : row.id))
                    }
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm text-text-primary">{row.name}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {row.durationMinutes} min
                      {row.bufferMinutes > 0 && ` + ${row.bufferMinutes} gap`}
                      {row.capacity > 1 && ` · ${row.capacity} at once`}
                      {row.price !== null && ` · ${formatCurrency(Number(row.price))}`}
                    </span>
                  </button>

                  <IconButton
                    label={`Remove ${row.name}`}
                    danger
                    onClick={() => deleteService.mutate(row.id)}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={2} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </Panel>

          {previewServiceId && <NextFree serviceId={previewServiceId} />}
        </>
      )}
    </div>
  );
}

/**
 * The next few free times for one service.
 *
 * Shown on demand rather than beside every service, because it is a real query
 * against the diary and an owner with fifteen services does not need fifteen of
 * them run to look at a list. It is also the only honest way to answer "is my
 * setup right?", a service with no free slots and full opening hours means
 * something is misconfigured, and this is where that becomes visible.
 */
function NextFree({ serviceId }: { serviceId: string }): React.JSX.Element {
  const { data, isLoading } = useSlots(serviceId, 7);

  return (
    <Panel>
      <PanelHead title="Next free times" meta="Next 7 days" />

      {isLoading && <SkeletonRows count={2} />}

      {data?.reason === 'no_opening_hours' && (
        <p className="p-4 text-sm text-warning">
          Flowdesk cannot offer any times because nobody has said when you are open. Set your
          opening hours in Settings and this fills in straight away.
        </p>
      )}

      {data?.reason === 'fully_booked' && (
        <p className="p-4 text-sm text-text-muted">
          Nothing free in the next seven days.
        </p>
      )}

      {data && data.slots.length > 0 && (
        <div className="flex flex-wrap gap-2 p-4">
          {data.slots.slice(0, 18).map((slot) => (
            <span
              key={`${slot.startsAt}-${slot.resourceIndex}`}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-secondary"
            >
              {formatDay(slot.startsAt, true)} {formatTime(slot.startsAt)}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'rounded-md p-2 text-text-muted transition-colors hover:bg-surface-hover',
        danger ? 'hover:text-danger' : 'hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

/*
 * Formatting.
 *
 * Every one of these pins `timeZone: 'UTC'`. Ghana is UTC+0 year-round, so UTC
 * IS the shop's wall clock, but the browser's own zone is whatever the laptop
 * says, and an owner checking the diary from a phone that thinks it is in
 * London during British Summer Time would otherwise see every appointment an
 * hour late.
 */
function formatDay(iso: string, short = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: short ? 'short' : 'long',
    day: 'numeric',
    month: short ? 'short' : 'long',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  })
    .format(new Date(iso))
    .replace(/\u202f/g, ' ');
}

function minutesBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000);
}

function groupByDay(appointments: Appointment[]): Array<[string, Appointment[]]> {
  const groups = new Map<string, Appointment[]>();

  for (const appointment of appointments) {
    const day = appointment.startsAt.slice(0, 10);
    const list = groups.get(day) ?? [];
    list.push(appointment);
    groups.set(day, list);
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export type { Service };
