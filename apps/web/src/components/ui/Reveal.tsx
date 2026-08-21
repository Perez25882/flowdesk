import { useEffect, useRef, useState } from 'react';
import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Scroll-entry reveal.
 *
 * Replaces Framer Motion on the marketing page. That library is roughly 50KB
 * gzipped and it was being loaded to fade six cards in — on a product whose
 * users are on metered 3G. An IntersectionObserver and a CSS transition do the
 * same job for a few hundred bytes, and because it is a CSS transition it runs
 * off the main thread, so it stays smooth while the rest of the page is still
 * loading.
 *
 * The movement is 8px. Anything larger reads as an animation; this reads as
 * the page settling.
 *
 * It is progressive enhancement, not decoration with a hidden default: the
 * unrevealed state is applied by CSS only under `.fd-js`, a class set inline in
 * index.html. A visitor whose bundle has not arrived yet — the ordinary case on
 * a metered 3G connection in Accra — sees the page, not a blank column.
 */
export default function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  /** Milliseconds. Keep stagger between siblings in the 40-80ms range. */
  delay?: number;
  className?: string;
  as?: ElementType;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Honour the OS setting before doing any work at all: someone who has
    // asked for less motion should not pay for an observer either.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      // Fires slightly before the element reaches the fold, so it has finished
      // settling by the time it is properly in view.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.01 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      data-shown={shown ? 'true' : 'false'}
      style={{ transitionDelay: shown ? `${delay}ms` : '0ms' }}
      // The hidden state lives in CSS, gated on `.fd-js`, so an element whose
      // script never ran is visible rather than invisible. See globals.css.
      className={cn('fd-reveal', className)}
    >
      {children}
    </Tag>
  );
}
