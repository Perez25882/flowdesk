import { useState, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useSSE } from '@/hooks/useSSE';
import { isAuthenticated } from '@/hooks/useAuth';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import BottomNav from './BottomNav';

function useSidebarState(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('sidebar-collapsed');
    return stored === 'true';
  });

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const toggle = () => setCollapsed((prev) => !prev);

  return [collapsed, toggle];
}

export default function Layout(): React.JSX.Element {
  const [collapsed] = useSidebarState();
  const navigate = useNavigate();
  useSSE();

  useEffect(() => {
    if (!isAuthenticated()) {
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  return (
    <div className="flex h-screen bg-[var(--color-bg)]">
      <Sidebar collapsed={collapsed} />

      <div className="flex flex-1 flex-col min-w-0">
        <TopBar />

        <main className="flex-1 overflow-y-auto p-4 md:p-6 pb-24 md:pb-6">
          <Outlet />
        </main>

        <BottomNav />
      </div>
    </div>
  );
}
