import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Wallet,
  MoreHorizontal,
  Package,
  MessageSquare,
  UserCog,
  Settings2,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { getNavItemsForRole } from '@/config/navigation';
import { getUserRole, useLogout } from '@/hooks/useAuth';
import { useBadges } from '@/hooks/useBadges';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
  SheetClose,
} from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';

const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Wallet,
  Package,
  MessageSquare,
  UserCog,
  Settings2,
};

/**
 * Phone navigation.
 *
 * Four destinations plus an overflow. The active item is marked by a rule
 * along the top edge of its cell rather than by a filled pill, which keeps the
 * bar reading as one continuous surface instead of five separate buttons.
 *
 * Every cell clears 44px in both directions, and the bar respects the home
 * indicator inset so the last row of content is never trapped under it.
 */
export default function BottomNav(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const role = getUserRole();
  const visibleNavItems = getNavItemsForRole(role);
  const primaryItems = visibleNavItems.filter((item) => item.mobile);
  const overflowItems = visibleNavItems.filter((item) => !item.mobile);
  const { data: badges } = useBadges();
  const logout = useLogout();

  const overflowBadgeCount = overflowItems.reduce((sum, item) => {
    if (item.badge === 'reviewMessages') return sum + (badges?.reviewMessages ?? 0);
    if (item.badge === 'pendingOrders') return sum + (badges?.pendingOrders ?? 0);
    return sum;
  }, 0);

  function handleLogout(): void {
    setMoreOpen(false);
    logout.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });
  }

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-bottom-nav grid grid-flow-col border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        {primaryItems.map((item) => {
          const Icon = iconMap[item.icon]!;
          const isActive =
            location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
          const badgeCount =
            item.badge === 'pendingOrders'
              ? (badges?.pendingOrders ?? 0)
              : item.badge === 'reviewMessages'
                ? (badges?.reviewMessages ?? 0)
                : 0;

          return (
            <button
              key={item.path}
              type="button"
              onClick={() => navigate(item.path)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 pt-1.5',
                'text-2xs font-medium transition-colors duration-fast ease-out',
                'active:bg-surface-hover',
                isActive ? 'text-primary' : 'text-text-secondary',
              )}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 top-0 h-0.5 rounded-b-full bg-primary"
                />
              )}

              <span className="relative">
                <Icon className="h-5 w-5" strokeWidth={isActive ? 2.1 : 1.75} aria-hidden="true" />
                {badgeCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1.5 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 font-mono text-[10px] font-semibold leading-none text-white ring-2 ring-surface"
                  >
                    {badgeCount > 9 ? '9+' : badgeCount}
                  </span>
                )}
              </span>

              <span>{item.label}</span>
              {badgeCount > 0 && <span className="sr-only">{`, ${badgeCount} pending`}</span>}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More sections"
          className="relative flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 pt-1.5 text-2xs font-medium text-text-secondary transition-colors duration-fast ease-out active:bg-surface-hover"
        >
          <span className="relative">
            <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            {overflowBadgeCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface"
              />
            )}
          </span>
          <span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>

          <SheetBody className="p-3">
            <div className="space-y-px">
              {overflowItems.map((item) => {
                const Icon = iconMap[item.icon]!;
                const isActive = location.pathname.startsWith(item.path);
                const badgeCount =
                  item.badge === 'reviewMessages' ? (badges?.reviewMessages ?? 0) : 0;

                return (
                  <SheetClose asChild key={item.path}>
                    <button
                      type="button"
                      onClick={() => navigate(item.path)}
                      className={cn(
                        'flex min-h-[48px] w-full items-center gap-3 rounded-md px-3 text-left text-base font-medium',
                        'transition-colors duration-fast ease-out active:bg-surface-hover',
                        isActive ? 'bg-primary-muted text-primary' : 'text-text-primary',
                      )}
                    >
                      <Icon
                        className="h-[18px] w-[18px] shrink-0"
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                      <span className="flex-1">{item.label}</span>
                      {badgeCount > 0 && (
                        <span className="fd-figure rounded-sm bg-danger-muted px-1.5 py-px text-2xs font-semibold text-danger">
                          {badgeCount}
                        </span>
                      )}
                    </button>
                  </SheetClose>
                );
              })}
            </div>

            <div className="mt-2 border-t border-border-subtle pt-2">
              <button
                type="button"
                onClick={handleLogout}
                disabled={logout.isPending}
                className="flex min-h-[48px] w-full items-center gap-3 rounded-md px-3 text-left text-base font-medium text-text-secondary transition-colors duration-fast ease-out active:bg-surface-hover disabled:opacity-50"
              >
                <LogOut className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
