import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, LogOut, Menu, X } from 'lucide-react';
import { getPageTitle } from '@/config/navigation';
import { Sheet, SheetTrigger, SheetContent, SheetClose } from '@/components/ui/Sheet';
import Sidebar from './Sidebar';
import { useSSE } from '@/hooks/useSSE';
import { useBadges } from '@/hooks/useBadges';
import { useLogout } from '@/hooks/useAuth';

export default function TopBar(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { connected: isSseConnected } = useSSE();
  const { data: badges } = useBadges();
  const logout = useLogout();

  const pageTitle = getPageTitle(location.pathname);
  // Bell badge aggregates everything that needs the owner's attention right now.
  const unreadCount =
    (badges?.pendingOrders ?? 0) + (badges?.reviewMessages ?? 0) + (badges?.lowStockProducts ?? 0);

  function handleLogout(): void {
    logout.mutate(undefined, {
      onSettled: () => {
        navigate('/login', { replace: true });
      },
    });
  }

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
        <div
          className={`hidden items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 sm:flex ${
            isSseConnected
              ? 'bg-[var(--color-success-muted)]'
              : 'bg-[var(--color-danger-muted)]'
          }`}
          aria-live="polite"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              isSseConnected
                ? 'bg-[var(--color-success)] animate-pulse'
                : 'bg-[var(--color-danger)]'
            }`}
          />
          <span
            className={`text-xs font-medium ${
              isSseConnected
                ? 'text-[var(--color-success)]'
                : 'text-[var(--color-danger)]'
            }`}
          >
            {isSseConnected ? 'Connected' : 'Reconnecting'}
         </span>
       </div>

        <button
          className="relative flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-bg)]" />
          )}
       </button>

        <button
          onClick={handleLogout}
          disabled={logout.isPending}
          aria-label="Sign out"
          className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
        >
          <LogOut className="h-5 w-5" />
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
