import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Package,
  Wallet,
  MessageSquare,
  UserCog,
  Settings2,
  BarChart3,
  CalendarDays,
  Circle,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { getGroupedNavItems, type NavItem } from '@/config/navigation';
import { getUserRole, useLogout } from '@/hooks/useAuth';
import { useBadges } from '@/hooks/useBadges';
import { useBusiness } from '@/hooks/useBusiness';
import { cn } from '@/lib/utils';

/**
 * Nav icons, keyed by the name `config/navigation` stores.
 *
 * Every item in that file must have an entry here. It is a `Record<string, …>`
 * rather than a key-checked map, so adding a nav item with no icon here is not
 * a build error — it used to be a blank white screen instead, because the
 * lookup returned `undefined` and React was handed `undefined` as a component
 * type. `Bookings` and `Reports` shipped that way.
 */
const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Package,
  Wallet,
  MessageSquare,
  UserCog,
  Settings2,
  BarChart3,
  CalendarDays,
};

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse?: () => void;
  /** Set when rendered inside the mobile sheet, where collapsing makes no sense. */
  variant?: 'rail' | 'sheet';
  onNavigate?: () => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'FD';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Business identity sits at the top, not the bottom.
 *
 * Staff accounts can belong to more than one business, and getting that wrong
 * means recording a payment against the wrong shop. Which business you are
 * looking at is the first question the interface should answer.
 */
function BusinessIdentity({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const { data: business, isLoading } = useBusiness();
  const name = business?.name ?? '';
  const initials = business ? getInitials(business.name) : 'FD';
  const planLabel = business?.plan
    ? business.plan.charAt(0) + business.plan.slice(1).toLowerCase()
    : null;

  return (
    <div
      className={cn(
        'flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-3',
        collapsed && 'justify-center px-0',
      )}
    >
      {/* A squircle rather than a circle. Circles read as people; this is an
          organisation. */}
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold tracking-tight text-primary-contrast"
        aria-hidden="true"
      >
        {isLoading ? '' : initials}
      </span>

      {!collapsed && (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-text-primary">
            {isLoading ? (
              <span className="fd-skeleton inline-block h-3 w-24 align-middle" />
            ) : (
              name || 'Your business'
            )}
          </span>
          <span className="truncate text-2xs text-text-muted">
            {planLabel ? `${planLabel} plan` : 'Flowdesk'}
          </span>
        </span>
      )}
    </div>
  );
}

function SidebarItem({
  item,
  isActive,
  collapsed,
  onClick,
  badgeCount,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  badgeCount: number;
}): React.JSX.Element {
  // No `!` here. That assertion claimed a lookup could not miss, and when it
  // did, React was handed `undefined` as a component type and took down the
  // whole authenticated shell — every page, not just this row. A nav item whose
  // icon is missing should cost the shop a grey dot, not the dashboard.
  const Icon = iconMap[item.icon] ?? Circle;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-md py-2 text-sm',
        'transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
        collapsed ? 'justify-center px-0' : 'px-2.5',
        isActive
          ? 'bg-primary-muted font-semibold text-primary'
          : 'font-medium text-text-secondary [@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover [@media(hover:hover)and(pointer:fine)]:hover:text-text-primary',
      )}
    >
      {/* The active marker is a rule flush to the rail edge, the way a tab
          index sticks out of a ledger. */}
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute -left-3 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-primary"
        />
      )}

      <Icon
        className="h-[17px] w-[17px] shrink-0"
        strokeWidth={isActive ? 2.1 : 1.75}
        aria-hidden="true"
      />

      {!collapsed && <span className="truncate">{item.label}</span>}

      {badgeCount > 0 &&
        (collapsed ? (
          <span
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-danger"
            aria-hidden="true"
          />
        ) : (
          <span className="fd-figure ml-auto shrink-0 rounded-sm bg-danger-muted px-1.5 py-px text-2xs font-semibold text-danger">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ))}

      {badgeCount > 0 && (
        <span className="sr-only">{`, ${badgeCount} needing attention`}</span>
      )}
    </button>
  );
}

export default function Sidebar({
  collapsed,
  onToggleCollapse,
  variant = 'rail',
  onNavigate,
}: SidebarProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const role = getUserRole();
  const { data: business } = useBusiness();
  const groups = getGroupedNavItems(role, { bookings: business?.bookingsEnabled ?? false });
  const { data: badges } = useBadges();
  const logout = useLogout();

  const isSheet = variant === 'sheet';
  const isCollapsed = isSheet ? false : collapsed;

  // Map each nav badge key to the count returned by the backend.
  const badgeByPath = useMemo(() => {
    const map: Record<string, number> = {};
    for (const group of groups) {
      for (const item of group.items) {
        if (item.badge === 'pendingOrders') map[item.path] = badges?.pendingOrders ?? 0;
        if (item.badge === 'reviewMessages') map[item.path] = badges?.reviewMessages ?? 0;
      }
    }
    return map;
  }, [groups, badges]);

  function go(path: string): void {
    navigate(path);
    onNavigate?.();
  }

  function handleLogout(): void {
    logout.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });
  }

  return (
    <aside
      aria-label="Main"
      className={cn(
        'flex flex-col border-r border-border bg-surface',
        'transition-[width] duration-base ease-out',
        isSheet ? 'h-full w-full border-r-0' : 'hidden md:flex',
        !isSheet && (isCollapsed ? 'w-[64px]' : 'w-[228px]'),
      )}
    >
      <BusinessIdentity collapsed={isCollapsed} />

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {groups.map((group, groupIndex) => (
          <div key={group.id} className={cn(groupIndex > 0 && 'mt-5')}>
            {/* Group labels disappear when collapsed; a rule stands in for
                them so the grouping survives the narrow rail. */}
            {isCollapsed ? (
              groupIndex > 0 && <div className="mx-2 mb-2 h-px bg-border-subtle" aria-hidden="true" />
            ) : (
              <h2 className="fd-label mb-1.5 px-2.5">{group.label}</h2>
            )}

            <div className="space-y-px">
              {group.items.map((item) => (
                <SidebarItem
                  key={item.path}
                  item={item}
                  isActive={
                    location.pathname === item.path ||
                    location.pathname.startsWith(`${item.path}/`)
                  }
                  collapsed={isCollapsed}
                  onClick={() => go(item.path)}
                  badgeCount={badgeByPath[item.path] ?? 0}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div
        className={cn(
          'shrink-0 space-y-px border-t border-border p-3',
          isCollapsed && 'px-2',
        )}
      >
        <button
          type="button"
          onClick={handleLogout}
          disabled={logout.isPending}
          title={isCollapsed ? 'Sign out' : undefined}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md py-2 text-sm font-medium text-text-secondary',
            'transition-colors duration-fast ease-out disabled:opacity-50',
            '[@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover [@media(hover:hover)and(pointer:fine)]:hover:text-text-primary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isCollapsed ? 'justify-center px-0' : 'px-2.5',
          )}
        >
          <LogOut className="h-[17px] w-[17px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {!isCollapsed && <span>Sign out</span>}
        </button>

        {!isSheet && onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md py-2 text-sm font-medium text-text-muted',
              'transition-colors duration-fast ease-out',
              '[@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover [@media(hover:hover)and(pointer:fine)]:hover:text-text-primary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              isCollapsed ? 'justify-center px-0' : 'px-2.5',
            )}
          >
            {isCollapsed ? (
              <PanelLeftOpen className="h-[17px] w-[17px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-[17px] w-[17px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
            )}
            {!isCollapsed && <span>Collapse</span>}
          </button>
        )}
      </div>
    </aside>
  );
}
