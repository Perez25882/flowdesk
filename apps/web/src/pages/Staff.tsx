import { useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { useStaff, useInviteStaff } from '@/hooks/useStaff';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { getInitials } from '@/lib/utils';

type Role = 'MANAGER' | 'OPERATIONS' | 'DELIVERY';

/**
 * Who can do what.
 *
 * The role select used to offer three bare words. Choosing wrongly here is how
 * a delivery rider ends up able to see revenue, so each option now states what
 * it grants, and the choice is a radio list rather than a dropdown — the
 * consequences deserve to be visible before you commit to them.
 */
const ROLES: { value: Role; label: string; scope: string }[] = [
  {
    value: 'MANAGER',
    label: 'Manager',
    scope: 'Everything except billing.',
  },
  {
    value: 'OPERATIONS',
    label: 'Operations',
    scope: 'Orders, products, payments, customers.',
  },
  {
    value: 'DELIVERY',
    label: 'Delivery',
    scope: 'Only their own orders. No money.',
  },
];

const EMPTY_FORM = { name: '', phone: '', role: 'OPERATIONS' as Role };

export default function StaffPage(): React.JSX.Element {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const { data: staff, isLoading } = useStaff();
  const invite = useInviteStaff();

  const canInvite = form.name.trim().length > 0 && form.phone.replace(/\D/g, '').length >= 9;

  function handleInvite(): void {
    invite.mutate(form, {
      onSuccess: () => {
        setShowForm(false);
        setForm(EMPTY_FORM);
      },
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Staff"
        description="Who can use Flowdesk, and how much they see."
        actions={
          <Button
            size="sm"
            variant={showForm ? 'secondary' : 'primary'}
            onClick={() => setShowForm((open) => !open)}
            leadingIcon={showForm ? undefined : <Plus className="h-4 w-4" strokeWidth={2} />}
          >
            {showForm ? 'Cancel' : 'Invite someone'}
          </Button>
        }
      />

      {showForm && (
        <Panel>
          <PanelHead title="Invite a staff member" />

          <div className="p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">Their name</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Kwabena Asante"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">Their phone number</span>
                <input
                  type="tel"
                  inputMode="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="024 418 7702"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
                <span className="text-xs text-text-muted">
                  They sign in with this.
                </span>
              </label>
            </div>

            <fieldset className="mt-5">
              <legend className="mb-2.5 text-sm font-medium text-text-primary">
                What can they see?
              </legend>

              <div className="divide-y divide-border-subtle rounded-md border border-border">
                {ROLES.map((role) => (
                  <label
                    key={role.value}
                    className="flex cursor-pointer items-start gap-3 p-3 transition-colors duration-fast ease-out hover:bg-surface-hover"
                  >
                    <input
                      type="radio"
                      name="role"
                      value={role.value}
                      checked={form.role === role.value}
                      onChange={() => setForm({ ...form, role: role.value })}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-text-primary">{role.label}</span>
                      <span className="text-xs text-text-secondary">{role.scope}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {invite.isError && (
              <p role="alert" className="mt-4 text-sm font-medium text-danger">
                {(invite.error as Error).message}
              </p>
            )}

            <div className="mt-5 flex items-center gap-2">
              <Button onClick={handleInvite} disabled={!canInvite} isLoading={invite.isPending}>
                Send invitation
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowForm(false);
                  setForm(EMPTY_FORM);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <Panel>
        {isLoading && <SkeletonRows count={4} />}

        {!isLoading && (!staff || staff.length === 0) && (
          <EmptyState
            icon={Users}
            title="Just you so far"
            description="Give each person only what they need."
            action={{ label: 'Invite someone', onClick: () => setShowForm(true) }}
          />
        )}

        {!isLoading && staff && staff.length > 0 && (
          <RowList>
            {staff.map((member) => (
              <Row key={member.id}>
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-2xs font-semibold text-text-secondary"
                  >
                    {getInitials(member.name)}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {member.name}
                    </span>
                    <span className="fd-figure truncate text-xs text-text-muted">
                      {member.phone}
                    </span>
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-2">
                  <span className="hidden text-xs text-text-secondary sm:inline">
                    {ROLES.find((r) => r.value === member.role)?.label ?? member.role}
                  </span>

                  {!member.active ? (
                    <Badge tone="danger">Disabled</Badge>
                  ) : member.inviteAcceptedAt ? (
                    <Badge tone="success" withDot>
                      Active
                    </Badge>
                  ) : (
                    <Badge tone="warning" withDot>
                      Invited
                    </Badge>
                  )}
                </span>
              </Row>
            ))}
          </RowList>
        )}
      </Panel>
    </div>
  );
}
