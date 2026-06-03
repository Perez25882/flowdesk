import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bell, Menu, X } from 'lucide-react';
import { getPageTitle } from '@/config/navigation';
import { Sheet, SheetTrigger, SheetContent, SheetClose } from '@/components/ui/Sheet';
import Sidebar from './Sidebar';

export default function TopBar(): React.JSX.Element {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const pageTitle = getPageTitle(location.pathname);
  const isSseConnected = true; // Stub — real hook will replace
  const unreadCount = 2;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setMobileMenuOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="text-base font-semibold text-[var(--color-text-primary)]">
          {pageTitle}
        </h1>
      </div>

      <div className="flex items-center gap-2">
        {isSseConnected && (
          <div className="hidden items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-success-muted)] px-2 py-1 sm:flex">
            <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" />
            <span className="text-xs font-medium text-[var(--color-success)]">Connected</span>
          </div>
        )}

        <button className="relative flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-bg)]" />
          )}
        </button>
      </div>

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetTrigger asChild>
          <span className="hidden" />
        </SheetTrigger>
        <SheetContent side="left" className="!w-[280px] !p-0">
          <div className="flex h-full flex-col">
            <div className="flex h-14 items-center justify-between border-b border-[var(--color-border)] px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary)]">
                  <span className="text-xs font-bold text-white">FD</span>
                </div>
                <span className="text-base font-semibold tracking-tight text-[var(--color-text-primary)]">
                  Flowdesk
                </span>
              </div>
              <SheetClose className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                <X className="h-5 w-5" />
              </SheetClose>
            </div>
            <div className="flex-1 overflow-y-auto">
              <Sidebar collapsed={false} />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );
}
