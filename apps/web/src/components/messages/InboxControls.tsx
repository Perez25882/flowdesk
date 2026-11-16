import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can, decodeToken } from '@/hooks/useAuth';
import type { InboxState } from '@/hooks/useConversations';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';

type Assignee = NonNullable<InboxState['assignee']>;

export default function InboxControls({ customerId, inbox }: { customerId: string; inbox: InboxState }): React.JSX.Element {
  const [showAssignment, setShowAssignment] = useState(false);
  const [choice, choose] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const client = useQueryClient();
  const canManage = can('staff.manage');
  const staffId = decodeToken()?.staffId ?? null;
  const path = '/conversations/' + encodeURIComponent(customerId);
  const eligible = useQuery({ queryKey: ['inbox-assignees'], enabled: canManage && showAssignment,
    queryFn: () => apiFetch<Assignee[]>('/conversations/assignees') });
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['conversations'] });
    void client.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
  };
  const assignment = useMutation({ mutationFn: (id: string | null) => apiFetch<InboxState>(path + '/assignment', {
    method: 'PUT', body: { staffId: id, revision: inbox.revision },
  }), onSuccess: () => { choose(null); setFeedback('Assignment updated.'); }, onSettled: refresh });
  const read = useMutation({ mutationFn: (through: string | null) => apiFetch<InboxState>(path + '/read-state', {
    method: 'PUT', body: { through, revision: inbox.readRevision },
  }), onSuccess: (_, through) => setFeedback(through === null ? 'Conversation marked unread.' : 'Read position saved.'), onSettled: refresh });
  const unread = inbox.unread > 0 || inbox.manuallyUnread;
  const selected = choice ?? inbox.assignee?.id ?? '';
  return <section aria-label="Conversation assignment and read state" className="grid gap-1 border-b border-border px-4 py-2 text-sm">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="min-w-0 break-words">{inbox.assignee ? `Assigned to ${inbox.assignee.name}` : 'Unassigned'}</p>
      {inbox.unread > 0 && <span className="font-semibold">{inbox.unread} unread</span>}
      {inbox.unread === 0 && inbox.manuallyUnread && <span className="font-semibold">Marked unread</span>}
      <Button size="sm" variant="secondary" disabled={read.isPending} onClick={() => read.mutate(unread ? inbox.inboundPosition : null)}>
        {unread ? 'Mark read' : 'Mark unread'}</Button>
      {!canManage && staffId && (!inbox.assignee || inbox.assignee.id === staffId) && <Button size="sm" variant="secondary"
        disabled={assignment.isPending} onClick={() => assignment.mutate(inbox.assignee ? null : staffId)}>
        {inbox.assignee ? 'Return to shared queue' : 'Claim conversation'}</Button>}
    </div>
    {canManage && <details onToggle={(event) => setShowAssignment(event.currentTarget.open)}>
      <summary className="min-h-8 cursor-pointer py-1 font-medium">Manage assignment</summary>
      {eligible.isPending && showAssignment && <p role="status">Loading staff…</p>}
      {eligible.isError && <Button size="sm" variant="secondary" onClick={() => void eligible.refetch()}>Retry staff list</Button>}
      {eligible.data && <form className="flex flex-wrap items-center gap-2 pb-1" onSubmit={(event) => { event.preventDefault(); assignment.mutate(selected || null); }}>
        <label className="flex flex-wrap items-center gap-2">Responsible staff member
          <select className="fd-input fd-input-compact w-auto max-w-full" value={selected} onChange={(event) => choose(event.target.value)}>
            <option value="">Unassigned</option>
            {eligible.data.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </label>
        <Button size="sm" type="submit" disabled={assignment.isPending || selected === (inbox.assignee?.id ?? '')}>Save assignment</Button>
      </form>}
    </details>}
    {feedback && <p role="status" className="sr-only">{feedback}</p>}
    {(assignment.error || read.error) && <p role="alert" className="text-danger">{assignment.error?.message ?? read.error?.message}</p>}
  </section>;
}
