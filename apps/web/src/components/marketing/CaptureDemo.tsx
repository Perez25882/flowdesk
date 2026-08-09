import { cn } from '@/lib/utils';

/**
 * The hero asset: one message, and the order Flowdesk made from it.
 *
 * Static. No motion, no glass, no floating. It is built from the same tokens
 * as the application, so what a visitor sees here is what they get after
 * signing up — which is the only trust signal on this page that costs nothing
 * and cannot be faked.
 *
 * Stacks on a phone. The thread sits above the order rather than beside it,
 * because two 160px columns are unreadable at 375px.
 */

const THREAD = [
  { from: 'them' as const, body: 'Morning. You still have the 5kg jasmine rice?', at: '06:41' },
  { from: 'us' as const, body: 'Yes. GHS 92 a bag.', at: '06:44' },
  { from: 'them' as const, body: '2 bags and a crate of eggs. Sending momo now.', at: '06:46' },
];

const ITEMS = [
  { name: 'Jasmine rice, 5kg', qty: 2, unit: 92.0 },
  { name: 'Eggs, crate of 30', qty: 1, unit: 58.5 },
];

export default function CaptureDemo({ className }: { className?: string }): React.JSX.Element {
  const total = ITEMS.reduce((sum, i) => sum + i.qty * i.unit, 0);

  return (
    <div
      className={cn(
        'grid overflow-hidden rounded-xl border border-border bg-surface shadow-lg',
        'sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]',
        className,
      )}
      role="img"
      aria-label="A WhatsApp thread on the left and, on the right, the order Flowdesk built from it: reference FD-2214, two bags of 5kg jasmine rice and one crate of eggs, GHS 242.50 total, paid by mobile money."
    >
      <div className="flex flex-col border-b border-border bg-surface-sunken sm:border-b-0 sm:border-r">
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-2.5">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-text-primary text-2xs font-bold text-white"
          >
            AO
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">Ama Owusu</span>
            <span className="fd-figure truncate text-2xs text-text-muted">+233 24 418 7702</span>
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-2 p-3.5">
          {THREAD.map((m, i) => (
            <div
              key={i}
              className={cn('flex flex-col gap-0.5', m.from === 'us' ? 'items-end' : 'items-start')}
            >
              <p
                className={cn(
                  'max-w-[86%] rounded-lg px-2.5 py-1.5 text-xs leading-snug',
                  m.from === 'us'
                    ? 'rounded-br-xs bg-primary text-primary-contrast'
                    : 'rounded-bl-xs border border-border bg-surface text-text-primary',
                )}
              >
                {m.body}
              </p>
              <span className="fd-figure px-1 text-[10px] text-text-muted">{m.at}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border-subtle px-3.5 py-2.5">
          <span className="fd-figure text-sm font-semibold text-primary">FD-2214</span>
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-warning-border bg-warning-muted px-1.5 py-[3px] text-2xs font-bold uppercase tracking-wide text-warning">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
            Pending
          </span>
        </div>

        <div className="flex-1 divide-y divide-border-subtle">
          {ITEMS.map((item) => (
            <div key={item.name} className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
              <span className="min-w-0 truncate text-sm">{item.name}</span>
              <span className="flex shrink-0 items-baseline gap-3">
                <span className="fd-figure text-xs text-text-muted">×{item.qty}</span>
                <span className="fd-figure w-[62px] text-right text-sm text-text-secondary">
                  {item.unit.toFixed(2)}
                </span>
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-baseline justify-between border-t border-border px-3.5 py-3">
          <span className="fd-label">Total</span>
          <span className="fd-figure text-lg font-bold">GHS {total.toFixed(2)}</span>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-surface-sunken px-3.5 py-2.5">
          <span className="text-xs text-text-secondary">MTN mobile money</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
            Matched
          </span>
        </div>
      </div>
    </div>
  );
}
