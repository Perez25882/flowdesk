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
  type LucideIcon,
} from 'lucide-react';
import { getNavItemsForRole, type NavItem } from '@/config/navigation';
import { getUserRole } from '@/hooks/useAuth';

const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Package,
  Wallet,
  MessageSquare,
  UserCog,
  Settings2,
};

interface SidebarProps {
  collapsed: boolean;
}

interface BadgeCounts {
  pendingOrders: number;
  reviewMessages: number;
}

const mockBadgeCounts: BadgeCounts = {
  pendingOrders: 3,
  reviewMessages: 1,
};

function BusinessProfile(): React.JSX.Element {
  return (
    <div className="border-t border-[var(--color-border)] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-primary)] text-sm font-semibold text-white">
          AM
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">
            Ama&apos;s Grocery
          </p>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--color-primary-muted)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-primary-light)]">
              Starter
            </span>
          </div>
        </div>
      </div>
      <p className="mt-2 truncate text-xs text-[var(--color-text-muted)]">
        233244123456
      </p>
    </div>
  );
}

function SidebarItem({
  item,
  isActive,
  collapsed,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = iconMap[item.icon]!;
  const badgeCount = item.badge ? mockBadgeCounts[item.badge] : 0;

  return (
    <button
      onClick={onClick}
      className={`group relative flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors ${
        isActive
          ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary-light)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--color-primary)]" />
      )}
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && (
        <>
          <span className="truncate">{item.label}</span>
          {badgeCount > 0 && (
            <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--color-danger)] px-1.5 text-[11px] font-semibold text-white">
              {badgeCount}
            </span>
          )}
        </>
      )}
    </button>
  );
}

export default function Sidebar({ collapsed }: SidebarProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const role = getUserRole();
  const visibleNavItems = getNavItemsForRole(role);

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-[width] duration-[var(--transition-base)] ${
        collapsed ? 'w-[60px]' : 'w-[240px]'
      }`}
    >
      <div className="flex h-14 items-center border-b border-[var(--color-border)] px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary)]">
            <span className="text-xs font-bold text-white">FD</span>
          </div>
          {!collapsed && (
            <span className="text-base font-semibold tracking-tight text-[var(--color-text-primary)]">
              Flowdesk
            </span>
          )}
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 p-2 overflow-y-auto">
        {visibleNavItems.map((item) => (
          <SidebarItem
            key={item.path}
            item={item}
            isActive={location.pathname === item.path}
            collapsed={collapsed}
            onClick={() => navigate(item.path)}
          />
        ))}
      </nav>

      {!collapsed && <BusinessProfile />}
    </aside>
  );
}
