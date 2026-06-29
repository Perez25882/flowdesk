import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useSSE } from '@/hooks/useSSE';
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
  // Establish the singleton SSE connection for the entire dashboard tree.
  // Idempotent — multiple components can call useSSE without spawning new EventSources.
  useSSE();

  return (
    <div className="flex h-screen bg-[var(--color-bg)]">
      <Sidebar collapsed={collapsed} />

      <div className="flex flex-1 flex-col min-w-0">
        <TopBar />

        <main className="flex-1 overflow-y-auto p-4 pb-24 md:p-6 md:pb-6">
          <Outlet />
       </main>

        <BottomNav />
    </div>
  </div>
  );
}
