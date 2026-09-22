import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import WhatsAppHealthBanner from './WhatsAppHealthBanner';
import { useSSE } from '@/hooks/useSSE';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import BottomNav from './BottomNav';

function useSidebarState(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    // Guarded: a private-mode Safari throws on localStorage access, and a
    // crash here takes down the entire dashboard shell.
    try {
      return localStorage.getItem('sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('sidebar-collapsed', String(collapsed));
    } catch {
      /* Preference is not worth an error. */
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((prev) => !prev), []);

  return [collapsed, toggle];
}

export default function Layout(): React.JSX.Element {
  const [collapsed, toggleCollapsed] = useSidebarState();

  // Establish the singleton SSE connection for the entire dashboard tree.
  // Idempotent, multiple components can call useSSE without spawning new
  // EventSources.
  useSSE();

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      {/* First stop in the tab order. Without it, a keyboard user pages
          through the whole sidebar on every navigation. */}
      <a href="#main" className="fd-skip-link">
        Skip to content
      </a>

      <Sidebar collapsed={collapsed} onToggleCollapse={toggleCollapsed} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />

        <main
          id="main"
          tabIndex={-1}
          className="flex-1 overflow-y-auto px-4 pb-24 pt-4 focus:outline-none md:px-6 md:pb-8 md:pt-5"
        >
          {/* Above every page: a dead WhatsApp connection stops the whole
              product working, so it must not be buried in Settings. */}
          <div className="mx-auto flex w-full max-w-shell flex-col gap-5">
            <WhatsAppHealthBanner />
            <Outlet />
          </div>
        </main>

        <BottomNav />
      </div>
    </div>
  );
}
