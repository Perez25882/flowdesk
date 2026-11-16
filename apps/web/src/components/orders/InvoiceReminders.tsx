import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

type Reminder = { id: string; status: string; reason: string | null; send: { state: string; reason: string | null } | null };

export function InvoiceReminders({ invoiceId }: { invoiceId: string }): React.JSX.Element {
  const reminders = useQuery({ queryKey: ['commerce', 'reminders', invoiceId], refetchInterval: 5_000,
    queryFn: () => apiFetch<Reminder[]>(`/commerce/invoices/${invoiceId}/reminders`) });
  return <section aria-label="Payment reminders" className="grid gap-1">
    <h4 className="font-medium">Payment reminders</h4>
    {reminders.isPending && <p role="status">Loading reminders…</p>}
    {reminders.isError && <p role="alert">Reminder status is unavailable.</p>}
    {reminders.data?.length === 0 && <p>No reminders recorded.</p>}
    {reminders.data?.map((reminder) => {
      const reason = reminder.send?.reason ?? reminder.reason;
      return <p key={reminder.id}>{(reminder.send?.state ?? reminder.status).replaceAll('_', ' ')}
        {reason && ` · ${reason.replaceAll('_', ' ').toLowerCase()}`}</p>;
    })}
  </section>;
}
