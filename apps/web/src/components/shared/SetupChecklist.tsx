import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useOnboarding } from '@/hooks/useOnboarding';
import { Panel } from '@/components/ui/Panel';

export default function SetupChecklist(): React.JSX.Element | null {
  const { data } = useOnboarding();
  if (!data || data.ready) return null;
  return <Panel className="flex flex-wrap items-center justify-between gap-3 border-primary/30 p-4">
    <div>
      <h2 className="font-semibold">Finish setting up your workspace</h2>
      <p className="text-sm text-text-secondary">{data.steps.find((step) => step.blocking && !step.done)?.title}</p>
    </div>
    <Link to="/setup" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-contrast">
      Continue setup <ArrowRight aria-hidden="true" className="size-4" />
    </Link>
  </Panel>;
}
