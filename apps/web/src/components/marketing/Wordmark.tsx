import { cn } from '@/lib/utils';

/**
 * The mark.
 *
 * Three rules of decreasing length: a ledger settling, and a message thread
 * shortening as an order resolves. It reads at 16px on a favicon, which a
 * drawn glyph would not.
 *
 * It lived in three files with three slightly different sets of pixel values.
 * One definition now, so the brand cannot drift between the marketing page,
 * the sign-in screen and the 404.
 */
export default function Wordmark({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md';
  className?: string;
}): React.JSX.Element {
  const box = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  const text = size === 'sm' ? 'text-sm' : 'text-base';
  const bars =
    size === 'sm'
      ? ['w-[15px]', 'w-[10px]', 'w-[6px]']
      : ['w-[17px]', 'w-[11px]', 'w-[7px]'];

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 flex-col items-center justify-center gap-[3.5px] rounded-md bg-primary',
          box,
        )}
      >
        <span className={cn('h-[2.5px] rounded-full bg-white', bars[0])} />
        <span className={cn('h-[2.5px] rounded-full bg-white/70', bars[1])} />
        <span className={cn('h-[2.5px] rounded-full bg-white/45', bars[2])} />
      </span>
      <span className={cn('font-extrabold tracking-tight text-text-primary', text)}>Flowdesk</span>
    </span>
  );
}
