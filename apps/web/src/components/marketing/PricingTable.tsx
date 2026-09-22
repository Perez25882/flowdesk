import { Check } from 'lucide-react';
import {
  BILLABLE_PLAN_CODES,
  CONVERSATION_UNIT_NOTE,
  PLANS,
  PLAN_COMPARISON,
  type Plan,
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
 * Three cards, at every width. The previous desktop version was a comparison
 * table, which is the right shape for an analyst and the wrong one for a shop
 * owner: it asks you to read a grid of ticks before you know which column you
 * are even interested in. Cards answer the question people actually arrive
 * with, which is "what does it cost and is it for me", and the full grid is
 * still there underneath for anyone who wants to check a specific limit.
 *
 * The middle card is inverted. A recommendation that is only a small badge is
 * a recommendation nobody follows; making it the dark one means the eye lands
 * there first, which is the entire job of a recommended tier.
 */

const PLAN_LIST = BILLABLE_PLAN_CODES.map((code) => PLANS[code]);

/** The four lines worth putting on a card. The rest live in the grid below. */
const CARD_LINES = PLAN_COMPARISON.slice(0, 4);

function PlanCard({ plan, onChoose }: { plan: Plan; onChoose: () => void }): React.JSX.Element {
  const featured = plan.recommended;
  // "GHS 150" splits; "Custom" does not, and keeping it whole is correct.
  const [currency, amount] = plan.price.includes(' ')
    ? (plan.price.split(/\s+/) as [string, string])
    : ['', plan.price];

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl p-6 transition-[transform,box-shadow] duration-200 ease-out',
        featured
          ? 'fd-ink text-white shadow-xl lg:-my-3 lg:py-9'
          : 'bg-surface shadow-sm ring-1 ring-border-subtle',
        // Hover lift is gated: on a touch screen the state sticks after a tap
        // and the card stays raised until something else is pressed.
        '[@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-1',
        featured
          ? '[@media(hover:hover)_and_(pointer:fine)]:hover:shadow-xl'
          : '[@media(hover:hover)_and_(pointer:fine)]:hover:shadow-md',
      )}
    >
      {featured && (
        <span className="mb-4 self-start rounded-full bg-accent px-2.5 py-1 text-2xs font-bold uppercase tracking-wide text-white">
          Most shops pick this
        </span>
      )}

      <h3
        className={cn(
          'text-lg font-bold tracking-tight',
          featured ? 'text-white' : 'text-text-primary',
        )}
      >
        {plan.name}
      </h3>

      <p className={cn('mt-1 text-sm', featured ? 'text-text-on-ink-muted' : 'text-text-secondary')}>
        {plan.audience}
      </p>

      {/*
        Currency and amount are set apart. `fd-figure` is a tabular face, so
        rendering "GHS 150" as one run gives the three letters the same wide
        advance as the digits and the price reads as a part number. The amount
        is the thing being compared down a row of cards; the currency is a
        label on it.
      */}
      <div className="mt-6 flex items-baseline gap-2">
        <span
          className={cn(
            'text-sm font-semibold',
            featured ? 'text-text-on-ink-muted' : 'text-text-muted',
          )}
        >
          {currency}
        </span>
        <span
          className={cn(
            'fd-figure text-[2.75rem] font-extrabold leading-none tracking-tighter',
            featured ? 'text-white' : 'text-text-primary',
          )}
        >
          {amount}
        </span>
        <span className={cn('text-sm', featured ? 'text-text-on-ink-muted' : 'text-text-muted')}>
          {plan.period}
        </span>
      </div>

      <ul className="mt-6 flex flex-1 flex-col gap-3">
        {CARD_LINES.map((row) => {
          const value = row.value(plan);
          if (value === false) return null;

          return (
            <li key={row.label} className="flex items-baseline gap-2.5 text-sm">
              <Check
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  featured ? 'text-white' : 'text-primary',
                )}
                strokeWidth={2.75}
                aria-hidden="true"
              />
              <span className={featured ? 'text-text-on-ink' : 'text-text-secondary'}>
                {value === true ? (
                  row.label
                ) : (
                  <>
                    <span className="fd-figure font-semibold">{value}</span> {row.label.toLowerCase()}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <Button
        fullWidth
        className="mt-7"
        variant={featured ? 'secondary' : 'secondary'}
        onClick={onChoose}
      >
        Start free
      </Button>
    </div>
  );
}

export default function PricingTable({
  onChoose,
}: {
  onChoose: () => void;
}): React.JSX.Element {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3 lg:items-center lg:gap-5">
        {PLAN_LIST.map((plan) => (
          <PlanCard key={plan.code} plan={plan} onChoose={onChoose} />
        ))}
      </div>

      {/*
        The full grid, for the one person in twenty who wants to check a
        specific limit before signing up. Kept as a real table so a screen
        reader announces "Products, Growth, unlimited" rather than reading a
        row of loose numbers, and set in the page rather than in a panel so it
        reads as reference rather than as another thing to decide about.
      */}
      <details className="mt-10 group">
        <summary className="cursor-pointer list-none text-sm font-semibold text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary">
          Compare every limit
          <span className="ml-1.5 inline-block text-text-muted transition-transform duration-200 ease-out group-open:rotate-90">
            &rsaquo;
          </span>
        </summary>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left">
            <caption className="sr-only">Flowdesk plans compared</caption>
            <thead>
              <tr>
                <th scope="col" className="w-[40%] pb-3 text-sm font-semibold text-text-muted">
                  <span className="sr-only">Feature</span>
                </th>
                {PLAN_LIST.map((plan) => (
                  <th
                    key={plan.code}
                    scope="col"
                    className="pb-3 text-center text-sm font-bold tracking-tight text-text-primary"
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {PLAN_COMPARISON.map((row, index) => (
                <tr
                  key={row.label}
                  // Zebra striping rather than a rule between every row. Eight
                  // hairlines across four columns is a grid of boxes; the tint
                  // does the same job of keeping the eye on one row without
                  // drawing sixty lines to do it.
                  className={index % 2 === 1 ? 'bg-surface-sunken' : undefined}
                >
                  <th
                    scope="row"
                    className="rounded-l-md py-2.5 pl-3 pr-4 text-sm font-normal text-text-secondary"
                  >
                    {row.label}
                  </th>
                  {PLAN_LIST.map((plan) => {
                    const value = row.value(plan);
                    return (
                      <td
                        key={plan.code}
                        className="py-2.5 text-center text-sm last:rounded-r-md"
                      >
                        {value === true ? (
                          <>
                            <Check
                              className="mx-auto h-4 w-4 text-primary"
                              strokeWidth={2.5}
                              aria-hidden="true"
                            />
                            <span className="sr-only">Included</span>
                          </>
                        ) : value === false ? (
                          <>
                            <span aria-hidden="true" className="text-text-muted">
                              &ndash;
                            </span>
                            <span className="sr-only">Not included</span>
                          </>
                        ) : (
                          <span className="fd-figure font-medium text-text-primary">{value}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="mt-6 max-w-prose text-sm text-text-muted">{CONVERSATION_UNIT_NOTE}</p>
    </>
  );
}
