import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Users, Wallet, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { getNavItemsForRole } from '@/config/navigation';
import { getUserRole } from '@/hooks/useAuth';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetClose } from '@/components/ui/Sheet';

const bottomIconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Wallet,
};

const moreIconMap: Record<string, LucideIcon> = {
  Package,
  MessageSquare,
  UserCog,
  Settings2,
};

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Package, MessageSquare, UserCog, Settings2 } from 'lucide-react';
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

const mockBadgeCounts = {
  pendingOrders: 3,
  reviewMessages: 1,
};

export default function BottomNav(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const role = getUserRole();
  const visibleNavItems = getNavItemsForRole(role);
  const visibleMobileItems = visibleNavItems.filter((item) => item.mobile);
  const visibleMoreItems = visibleNavItems.filter((item) => !item.mobile);

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-center justify-around border-t border-[var(--color-border)] bg-[var(--color-surface)] pb-[env(safe-area-inset-bottom)] md:hidden">
        {visibleMobileItems.map((item) => {
          const Icon = bottomIconMap[item.icon]!;
          const isActive = location.pathname === item.path;
          const badgeCount = item.badge ? mockBadgeCounts[item.badge] : 0;

          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`relative flex flex-col items-center justify-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? 'text-[var(--color-primary-light)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
              {badgeCount > 0 && (
                <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-bold text-white">
                  {badgeCount}
                </span>
              )}
            </button>
          );
        })}

        <button
          onClick={() => setMoreOpen(true)}
          className="flex flex-col items-center justify-center gap-0.5 px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] transition-colors"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetTrigger asChild>
          <span className="hidden" />
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <div className="space-y-1">
              {visibleMoreItems.map((item) => {
                const Icon = moreIconMap[item.icon]!;
                const isActive = location.pathname === item.path;

                return (
                  <SheetClose asChild key={item.path}>
                    <button
                      onClick={() => navigate(item.path)}
                      className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-3 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary-light)]'
                          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  </SheetClose>
                );
              })}
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
