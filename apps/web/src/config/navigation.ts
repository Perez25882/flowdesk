export type NavGroup = 'today' | 'records' | 'business';

export interface NavItem {
  label: string;
  path: string;
  icon: string;
  group: NavGroup;
  /** Sentence shown under the page title. Sets expectations before the data loads. */
  description: string;
  badge?: 'pendingOrders' | 'reviewMessages';
  mobile?: boolean;
  roles?: string[];
  /**
   * A setting this item depends on. Hidden entirely when it is off.
   *
   * Distinct from `roles`, which is about permission. This is about relevance:
   * a shop selling bags has no diary, and showing it one is a nav item nobody
   * will ever open sitting between two they use every day.
   */
  feature?: 'bookings';
}

/** Which optional features this business has switched on. */
export interface NavFeatures {
  bookings?: boolean;
}

/**
 * Navigation is grouped by how often a shop owner touches it, not by data
 * model. "Today" is what they open the app for. "Records" is what they consult.
 * "Business" is what they configure once and forget.
 *
 * A flat list of eight items gives no clue which three matter every morning.
 */
export const NAV_GROUPS: { id: NavGroup; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'records', label: 'Records' },
  { id: 'business', label: 'Business' },
];

export const navItems: NavItem[] = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    icon: 'LayoutDashboard',
    group: 'today',
    description: 'What happened overnight and what needs you first.',
    mobile: true,
  },
  {
    label: 'Orders',
    path: '/orders',
    icon: 'ShoppingCart',
    group: 'today',
    description: 'Every order from first message to fulfilled.',
    badge: 'pendingOrders',
    mobile: true,
  },
  {
    label: 'Messages',
    path: '/messages',
    icon: 'MessageSquare',
    group: 'today',
    description: 'Messages Flowdesk could not read on its own.',
    badge: 'reviewMessages',
    roles: ['owner', 'MANAGER', 'OPERATIONS'],
  },
  {
    label: 'Customers',
    path: '/customers',
    icon: 'Users',
    group: 'records',
    description: 'Who buys from you, and who still owes you.',
    mobile: true,
    roles: ['owner', 'MANAGER', 'OPERATIONS'],
  },
  {
    label: 'Products',
    path: '/products',
    icon: 'Package',
    group: 'records',
    description: 'Your catalogue, prices and stock levels.',
    roles: ['owner', 'MANAGER', 'OPERATIONS'],
  },
  {
    label: 'Payments',
    path: '/payments',
    icon: 'Wallet',
    group: 'records',
    description: 'Mobile money, transfers and cash against each order.',
    mobile: true,
    roles: ['owner', 'MANAGER', 'OPERATIONS'],
  },
  {
    label: 'Bookings',
    path: '/bookings',
    icon: 'CalendarDays',
    group: 'today',
    description: 'Who is coming in, and what you offer.',
    feature: 'bookings',
    // On the mobile bar when it is on at all: a clinic's diary is the first
    // thing they open in the morning, which is what the bar is for.
    mobile: true,
    roles: ['owner', 'MANAGER', 'OPERATIONS'],
  },
  {
    label: 'Reports',
    path: '/reports',
    icon: 'BarChart3',
    group: 'records',
    description: 'How the shop is doing, over 30, 60 or 90 days.',
    // Not on the mobile bar. This is the page an owner opens sitting down,
    // and the bar has room for what they open standing up.
    roles: ['owner', 'MANAGER'],
  },
  {
    label: 'Staff',
    path: '/staff',
    icon: 'UserCog',
    group: 'business',
    description: 'Who can see and change what.',
    roles: ['owner', 'MANAGER'],
  },
  {
    label: 'Settings',
    path: '/settings',
    icon: 'Settings2',
    group: 'business',
    description: 'Your WhatsApp connection, business details and plan.',
    roles: ['owner', 'MANAGER', 'OPERATIONS'],
  },
];

export function getNavItemsForRole(role: string | null, features: NavFeatures = {}): NavItem[] {
  const effectiveRole = role ?? 'owner';

  return navItems.filter((item) => {
    if (item.roles && !item.roles.includes(effectiveRole)) return false;
    // An unknown feature key hides the item rather than showing it. A nav entry
    // that appears because a flag was misspelled leads to a page that cannot
    // work, which is worse than one the owner has to switch on.
    if (item.feature) return features[item.feature] === true;
    return true;
  });
}

export function getGroupedNavItems(
  role: string | null,
  features: NavFeatures = {},
): { id: NavGroup; label: string; items: NavItem[] }[] {
  const visible = getNavItemsForRole(role, features);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: visible.filter((item) => item.group === group.id),
  })).filter((group) => group.items.length > 0);
}

export const mobileBottomNavItems = navItems.filter((item) => item.mobile);
export const moreNavItems = navItems.filter((item) => !item.mobile);

/** Feature-gated items, for the "everything else" sheet. */
export function visibleMobileItems(role: string | null, features: NavFeatures = {}): NavItem[] {
  return getNavItemsForRole(role, features).filter((item) => item.mobile);
}

export function getNavItem(pathname: string): NavItem | undefined {
  // Longest match first, so /customers/:id resolves to Customers rather than
  // falling through to the default.
  return [...navItems]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
}

export function getPageTitle(pathname: string): string {
  return getNavItem(pathname)?.label ?? 'Flowdesk';
}
