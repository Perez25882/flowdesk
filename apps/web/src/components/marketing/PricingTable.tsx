import { Check, Minus } from 'lucide-react';
import {
  BILLABLE_PLAN_CODES,
  CONVERSATION_UNIT_NOTE,
  PLANS,
  PLAN_COMPARISON,
} from '@/config/plans';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * Pricing, read from `config/plans.ts`.
 *
 * The marketing page used to hold its own copy of the numbers and quoted
 * prices the billing screen did not honour. Nothing here is typed by hand any
 * more; changing a plan means editing one file.
 *
 * Two presentations of the same data. A comparison table is the right shape
 * for someone weighing three tiers, but a four-column table at 375px is
 * either unreadable or needs a horizontal scroll that hides the column you
 * are comparing against. So phones get stacked cards, desktops get the table.
 *
 * The note under both presentations says what a "conversation" is and what
 * happens at the ceiling. A monthly allowance whose unit is unstated is the
 * kind of number a customer only understands on the day it runs out.
 */

const PLAN_LIST = BILLABLE_PLAN_CODES.map((code) => PLANS[code]);

function Cell({ value }: { value: string | boolean }): React.JSX.Element {
  if (value === true) {
    return (
      <>
        <Check className="mx-auto h-4 w-4 text-primary" strokeWidth={2.5} aria-hidden="true" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <Minus className="mx-auto h-4 w-4 text-border-strong" strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <span className="fd-figure text-sm font-medium">{value}</span>;
}

export default function PricingTable({
  onChoose,
}: {
  onChoose: () => void;
}): React.JSX.Element {
  return (
    <>
      {/* ── Phones: one card per plan ── */}
      <div className="flex flex-col gap-3 md:hidden">
        {PLAN_LIST.map((plan) => (
          <div
            key={plan.code}
            className={cn(
              'rounded-xl border bg-surface p-5',
              plan.recommended ? 'border-primary' : 'border-border',
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-lg font-bold tracking-tight">{plan.name}</span>
              {plan.recommended && (
                <span className="rounded-sm bg-primary-light px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide text-primary">
                  Recommended
                </span>
              )}
            </div>

            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="fd-figure text-2xl font-extrabold tracking-tight">{plan.price}</span>
              <span className="text-sm text-text-muted">{plan.period}</span>
            </div>

            <p className="mt-1.5 text-sm text-text-secondary">{plan.audience}</p>

            <dl className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
              {PLAN_COMPARISON.map((row) => {
                const value = row.value(plan);
                if (value === false) return null;
                return (
                  <div key={row.label} className="flex items-baseline justify-between gap-3 py-2">
                    <dt className="text-sm text-text-secondary">{row.label}</dt>
                    <dd className="shrink-0">
                      {value === true ? (
                        <Check className="h-4 w-4 text-primary" strokeWidth={2.5} aria-label="Included" />
                      ) : (
                        <span className="fd-figure text-sm font-medium">{value}</span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>

            <Button
              fullWidth
              className="mt-4"
              variant={plan.recommended ? 'primary' : 'secondary'}
              onClick={onChoose}
            >
              Start free
            </Button>
          </div>
        ))}
      </div>

      {/* ── Desktop: the comparison ── */}
      <table className="hidden w-full border-collapse text-left md:table">
        <caption className="sr-only">Flowdesk plans compared</caption>

        <thead>
          <tr>
            <th scope="col" className="w-[34%] pb-5 align-bottom">
              <span className="fd-label">Plan</span>
            </th>
            {PLAN_LIST.map((plan) => (
              <th
                key={plan.code}
                scope="col"
                className={cn(
                  'px-4 pb-5 pt-4 align-bottom',
                  plan.recommended && 'rounded-t-lg bg-primary-light',
                )}
              >
                <span className="flex flex-col gap-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-base font-bold tracking-tight">{plan.name}</span>
                    {plan.recommended && (
                      <span className="text-2xs font-bold uppercase tracking-wide text-primary">
                        Recommended
                      </span>
                    )}
                  </span>
                  <span className="fd-figure text-2xl font-extrabold leading-none tracking-tight">
                    {plan.price}
                  </span>
                  <span className="text-xs font-normal text-text-muted">{plan.period}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {PLAN_COMPARISON.map((row) => (
            <tr key={row.label} className="border-t border-border-subtle">
              <th scope="row" className="py-3 pr-4 text-sm font-normal text-text-secondary">
                {row.label}
              </th>
              {PLAN_LIST.map((plan) => (
                <td
                  key={plan.code}
                  className={cn('px-4 py-3 text-center', plan.recommended && 'bg-primary-light')}
                >
                  <Cell value={row.value(plan)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>

        <tfoot>
          <tr className="border-t border-border">
            <td />
            {PLAN_LIST.map((plan) => (
              <td
                key={plan.code}
                className={cn('px-4 pb-4 pt-5', plan.recommended && 'rounded-b-lg bg-primary-light')}
              >
                <Button
                  fullWidth
                  size="sm"
                  variant={plan.recommended ? 'primary' : 'secondary'}
                  onClick={onChoose}
                >
                  Start free
                </Button>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>

      <p className="mt-6 max-w-prose text-sm leading-relaxed text-text-secondary">
        {CONVERSATION_UNIT_NOTE}
      </p>
    </>
  );
}
