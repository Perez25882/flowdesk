import { useState } from 'react';
import { Users, Plus, UserCheck, UserX } from 'lucide-react';
import { useStaff, useInviteStaff } from '@/hooks/useStaff';
import EmptyState from '@/components/shared/EmptyState';

export default function StaffPage(): React.JSX.Element {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', role: 'OPERATIONS' as 'MANAGER' | 'OPERATIONS' | 'DELIVERY' });
  const { data: staff, isLoading } = useStaff();
  const invite = useInviteStaff();

  const handleInvite = () => {
    invite.mutate(form, {
      onSuccess: () => {
        setShowForm(false);
        setForm({ name: '', phone: '', role: 'OPERATIONS' });
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Staff</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-light)]"
        >
          <Plus className="h-4 w-4" /> Invite Staff
        </button>
      </div>

      {showForm && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone (233XXXXXXXXX)" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })} className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
              <option value="MANAGER">Manager</option>
              <option value="OPERATIONS">Operations</option>
              <option value="DELIVERY">Delivery</option>
            </select>
          </div>
          <button onClick={handleInvite} className="mt-3 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-light)]">
            Send Invite
          </button>
        </div>
      )}

      {isLoading && <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />}
      {!isLoading && (!staff || staff.length === 0) && <EmptyState icon={Users} title="No staff yet" description="Invite staff to help manage orders, inventory, and customers." />}

      {!isLoading && staff && staff.length > 0 && (
        <div className="space-y-2">
          {staff.map((member) => (
            <div key={member.id} className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary-muted)]">
                  <Users className="h-4 w-4 text-[var(--color-primary-light)]" />
                </div>
                <div>
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">{member.name}</span>
                  <p className="text-xs text-[var(--color-text-muted)]">{member.phone} &middot; {member.role}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {member.inviteAcceptedAt ? (
                  <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-success-muted)] px-2 py-1 text-[10px] text-[var(--color-success)]">
                    <UserCheck className="h-3 w-3" /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-warning-muted)] px-2 py-1 text-[10px] text-[var(--color-warning)]">
                    <UserX className="h-3 w-3" /> Pending
                  </span>
                )}
                {!member.active && <span className="text-[10px] text-[var(--color-danger)]">Inactive</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
