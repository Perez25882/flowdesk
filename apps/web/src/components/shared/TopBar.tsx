import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { getPageTitle } from '@/config/navigation';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/Sheet';
import Sidebar from './Sidebar';
import { useSSE } from '@/hooks/useSSE';
import { cn } from '@/lib/utils';

/**
 * Slim utility bar.
 *
 * It deliberately holds almost nothing. The page title, page description and
 * page actions all live in each page's own `PageHeader`, because a global
 * toolbar that carries both "New order" and "Sign out" teaches the user that
 * the two are equally consequential.
 *
 * What is left here is genuinely global: the way into navigation on a phone,
 * and whether the live connection is up.
 */

/**
 * Live connection state.
 *
 * Worth a permanent slot because this product is a real-time one: when the
 * stream drops, the board silently stops updating and a stale board is worse
 * than an empty one. Shown as text, not a bare coloured dot.
 */
function ConnectionState({ connected }: { connected: boolean }): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-1.5"
      aria-live="polite"
      title={
        connected
          ? 'Live. New orders appear without refreshing.'
          : 'Reconnecting. New orders may be delayed.'
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          connected ? 'bg-success' : 'bg-warning motion-safe:animate-pulse',
        )}
      />
      <span
        className={cn(
          'text-xs font-medium',
          connected ? 'text-text-muted' : 'text-warning',
        )}
      >
        {connected ? 'Live' : 'Reconnecting'}
      </span>
    </div>
  );
}

export default function TopBar(): React.JSX.Element {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { connected } = useSSE();

  const pageTitle = getPageTitle(location.pathname);

  return (
    <header className="sticky top-0 z-header flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:h-12 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          aria-label="Open navigation"
          className="-ml-2.5 flex h-11 w-11 items-center justify-center rounded-md text-text-secondary transition-colors duration-fast ease-out hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </button>

        {/* The title shows on mobile only. On desktop the page's own header
            carries it, at a size that can actually hold a page. */}
        <span className="truncate text-base font-semibold tracking-tight text-text-primary md:hidden">
          {pageTitle}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <ConnectionState connected={connected} />
      </div>

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-[min(84vw,272px)]">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar
            collapsed={false}
            variant="sheet"
            onNavigate={() => setMobileMenuOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </header>
  );
}
