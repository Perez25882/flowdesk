import { useCallback, useSyncExternalStore } from 'react';

/**
 * Tracks a CSS media query.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the match is
 * external state, and reading it during render avoids the one-frame flash of
 * the wrong layout that the effect-based version produces.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // Server snapshot. There is no SSR here, but `useSyncExternalStore` requires
  // it and it keeps the hook safe if the app is ever prerendered.
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Matches Tailwind's `md` breakpoint, the point where the order board appears. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)');
}
