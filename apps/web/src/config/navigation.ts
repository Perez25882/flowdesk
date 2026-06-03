export interface NavItem {
  label: string;
  path: string;
  icon: string;
  badge?: 'pendingOrders' | 'reviewMessages';
  mobile?: boolean;
  roles?: string[];
}

export const navItems: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: 'LayoutDashboard', mobile: true },
  { label: 'Orders', path: '/orders', icon: 'ShoppingCart', badge: 'pendingOrders', mobile: true },
  { label: 'Customers', path: '/customers', icon: 'Users', mobile: true, roles: ['owner', 'MANAGER', 'OPERATIONS'] },
  { label: 'Products', path: '/products', icon: 'Package', roles: ['owner', 'MANAGER', 'OPERATIONS'] },
  { label: 'Payments', path: '/payments', icon: 'Wallet', mobile: true, roles: ['owner', 'MANAGER', 'OPERATIONS'] },
  { label: 'Messages', path: '/messages', icon: 'MessageSquare', badge: 'reviewMessages', roles: ['owner', 'MANAGER', 'OPERATIONS'] },
  { label: 'Staff', path: '/staff', icon: 'UserCog', roles: ['owner', 'MANAGER'] },
  { label: 'Settings', path: '/settings', icon: 'Settings2', roles: ['owner', 'MANAGER', 'OPERATIONS'] },
];

export function getNavItemsForRole(role: string | null): NavItem[] {
  const effectiveRole = role ?? 'owner';
  return navItems.filter((item) => !item.roles || item.roles.includes(effectiveRole));
}

export const mobileBottomNavItems = navItems.filter((item) => item.mobile);
export const moreNavItems = navItems.filter((item) => !item.mobile);

export function getPageTitle(pathname: string): string {
  const item = navItems.find((item) => item.path === pathname);
  return item?.label ?? 'Flowdesk';
}
