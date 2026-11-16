import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, ClipboardList, MessageSquare, Wallet } from 'lucide-react';
import { useBusiness } from '@/hooks/useBusiness';
import { can, isOwner } from '@/hooks/useAuth';
import { useTabParam } from '@/hooks/useTabParam';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';
import { workspaceFeatures } from '@/config/navigation';
import { apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import PageHeader from '@/components/shared/PageHeader';
import SetupChecklist from '@/components/shared/SetupChecklist';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { Tabs } from '@/components/ui/Tabs';

const WorkCenter = lazy(() => import('@/components/shared/WorkCenter'));
const DailyInsight = lazy(() => import('@/components/shared/DailyInsight'));
const overviewTabs = [{ value: 'overview', label: 'Overview' }, { value: 'work', label: 'Work center' }, { value: 'insights', label: 'Daily insights' }] as const;
const ownerViews = ['overview', 'work', 'insights'] as const;
const staffViews = ['overview'] as const;

export interface WorkspaceOverview {
  orders: { received: number; pending: number; preparing: number; dispatched: number; fulfilled: number };
  visits: { upcoming: number; held: number; completed: number; missed: number; blocked: number } | null;
  care: { open: number } | null;
  money: { verifiedReceipts: string; outstandingInvoices: string; openInvoices: number } | null;
  decisions: { approvals: number; exceptions: number; completed: number } | null;
}

function MetricLink({ label, value, detail, to, icon: Icon }: {
  label: string; value: string | number; detail: string; to: string; icon: typeof Wallet;
}): React.JSX.Element {
  return <Link to={to} className="group flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4
    transition-colors hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
    <span className="flex items-center justify-between gap-2 text-sm text-text-secondary">
      <span className="flex items-center gap-2"><Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />{label}</span>
      <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
    </span>
    <strong className="fd-figure break-words text-2xl font-semibold tracking-tight">{value}</strong>
    <span className="text-sm text-text-secondary">{detail}</span>
  </Link>;
}

export default function DashboardPage(): React.JSX.Element {
  const owner = isOwner();
  const [view, setView] = useTabParam('view', owner ? ownerViews : staffViews, 'overview');
  const business = useBusiness(can('settings.read'));
  const features = workspaceFeatures(business.data);
  const summary = useQuery({
    queryKey: ['dashboard', 'overview'], queryFn: () => apiFetch<WorkspaceOverview>('/dashboard/overview'),
    enabled: view === 'overview', refetchInterval: 30_000,
  });
  useRealtimeOrders();
  const data = summary.data;
  return <div className="grid min-w-0 gap-5">
    <PageHeader title="Overview" description={business.data ? business.data.name + ' · Today' : 'Today'}
      actions={<Link to={features.service ? '/bookings?view=operations' : '/orders'} className="inline-flex min-h-10 items-center text-sm font-semibold text-primary underline underline-offset-4">
        {features.service ? 'Open bookings' : 'Open orders & work'}
      </Link>} />
    {owner && <Tabs label="Overview workspace" options={overviewTabs} value={view} onChange={setView} />}
    {view === 'work' && owner && <Suspense fallback={<p role="status">Loading work center…</p>}><WorkCenter /></Suspense>}
    {view === 'insights' && owner && <Suspense fallback={<p role="status">Loading daily insights…</p>}><DailyInsight /></Suspense>}
    {view === 'overview' && <>
      {owner && <SetupChecklist />}
      {summary.isPending && <p role="status">Loading your overview…</p>}
      {summary.isError && <div role="alert" className="rounded-lg border border-border bg-surface p-4">
        <p className="mb-2">The latest business figures could not load.</p>
        <Button variant="secondary" size="sm" onClick={() => void summary.refetch()}>Try again</Button>
      </div>}
      {data && <>
        {data.decisions && <Panel>
          <PanelHead title="Needs your attention" />
          <div className="grid gap-px bg-border sm:grid-cols-3">
            <Link to="/dashboard?view=work&state=WAITING_OWNER_APPROVAL" className="bg-surface p-4 text-sm hover:bg-surface-hover">
              <strong className="fd-figure mr-2 text-base">{data.decisions.approvals}</strong>Owner approvals</Link>
            <Link to="/dashboard?view=work&state=REVIEW_REQUIRED" className="bg-surface p-4 text-sm hover:bg-surface-hover">
              <strong className="fd-figure mr-2 text-base">{data.decisions.exceptions}</strong>Exceptions to review</Link>
            <Link to="/dashboard?view=work&state=COMPLETED" className="bg-surface p-4 text-sm hover:bg-surface-hover">
              <strong className="fd-figure mr-2 text-base">{data.decisions.completed}</strong>Completed today</Link>
          </div>
        </Panel>}
        <section aria-label="Business activity" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(!features.service || data.orders.received + data.orders.pending + data.orders.preparing + data.orders.dispatched > 0) &&
            <MetricLink label="Orders received" value={data.orders.received} detail={data.orders.pending + ' awaiting confirmation · ' + data.orders.preparing + ' in preparation'}
              to="/orders" icon={ClipboardList} />}
          {data.visits && features.bookings && <MetricLink label="Upcoming appointments" value={data.visits.upcoming}
            detail={'Next seven days · ' + data.visits.held + ' holds · ' + data.visits.blocked + ' blocked'} to="/bookings?view=operations" icon={CalendarDays} />}
          {data.money && <>
            <MetricLink label="Verified receipts today" value={formatCurrency(Number(data.money.verifiedReceipts))} detail="Independently verified payments"
              to="/payments" icon={Wallet} />
            <MetricLink label="Outstanding invoices" value={formatCurrency(Number(data.money.outstandingInvoices))} detail={data.money.openInvoices + ' with a balance'}
              to="/payments?view=invoices" icon={Wallet} />
          </>}
          {data.care && <MetricLink label="Open customer cases" value={data.care.open} detail="Waiting for a resolution" to="/messages?view=cases" icon={MessageSquare} />}
        </section>
        {data.orders.dispatched > 0 && <Link to="/orders?status=DISPATCHED" className="justify-self-start text-sm text-primary underline">
          View {data.orders.dispatched} orders out for delivery</Link>}
      </>}
    </>}
  </div>;
}
