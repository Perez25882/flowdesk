import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check } from 'lucide-react';
import { useOnboarding } from '@/hooks/useOnboarding';
import { Panel } from '@/components/ui/Panel';
import { cn } from '@/lib/utils';

/**
 * What is left before this shop can actually be run from here.
 *
 * On the dashboard, above everything, and gone the moment it is finished. Two
 * decisions worth naming:
 *
 * It shows the NEXT step expanded and the rest collapsed, rather than six
 * equally-weighted rows. A list of six things is a list nobody starts; one
 * thing with a button is a thing that gets done.
 *
 * And it does not congratulate. A tick is a tick, the reward for finishing
 * setup is that the checklist disappears, which is the only reward an owner at
 * 6am actually wants.
 */
export default function SetupChecklist(): React.JSX.Element | null {
  const navigate = useNavigate();
  const { data } = useOnboarding();

  if (!data || data.ready || data.steps.length === 0) return null;

  // The blocking step jumps the queue regardless of order: without WhatsApp
  // connected, nothing else on the list changes anything.
  const next =
    data.steps.find((step) => !step.done && step.blocking) ??
    data.steps.find((step) => !step.done);

  if (!next) return null;

  const warned = data.steps.filter((step) => step.warning);

  return (
    <Panel className="border-primary/30">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-text-primary">Finish setting up</span>
          <span className="fd-figure text-xs text-text-muted">
            {data.completed} of {data.total}
          </span>
        </div>

        {/* A bar rather than a percentage: nobody needs "50%", they need to see
            how much is left. */}
        <span
          className="h-1.5 overflow-hidden rounded-full bg-surface-hover"
          role="progressbar"
          aria-valuenow={data.completed}
          aria-valuemin={0}
          aria-valuemax={data.total}
          aria-label="Setup progress"
        >
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${(data.completed / data.total) * 100}%` }}
          />
        </span>

        {warned.map((step) => (
          <p
            key={step.id}
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              strokeWidth={2}
              aria-hidden="true"
            />
            {step.warning}
          </p>
        ))}

        <div className="rounded-lg border border-border bg-surface-hover p-4">
          <p className="text-sm font-medium text-text-primary">{next.title}</p>
          <p className="mt-1 max-w-prose text-xs text-text-muted">{next.why}</p>
          <button
            type="button"
            onClick={() => navigate(next.href)}
            className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {next.blocking ? 'Connect now' : 'Set this up'}
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <ul className="flex flex-col gap-1.5">
          {data.steps
            .filter((step) => step.id !== next.id)
            .map((step) => (
              <li key={step.id}>
                <button
                  type="button"
                  onClick={() => navigate(step.href)}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      step.done
                        ? 'border-success bg-success text-white'
                        : 'border-border text-transparent',
                    )}
                    aria-hidden="true"
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-sm',
                      step.done ? 'text-text-muted line-through' : 'text-text-secondary',
                    )}
                  >
                    {step.title}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </Panel>
  );
}
