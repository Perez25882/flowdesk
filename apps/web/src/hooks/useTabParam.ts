import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Keeps a tab selection in the URL.
 *
 * Every tabbed view here previously held its state in `useState`, which meant
 * none of it could be linked to. That matters more than it sounds: a shop
 * owner cannot send a staff member a link to the payments needing checking,
 * cannot bookmark the cancelled orders, and loses their place on every
 * refresh — including the refresh that happens when the browser reclaims a
 * backgrounded tab on a low-memory Android.
 *
 * `replace` is used so flipping between tabs does not fill the back stack;
 * pressing Back should leave the page, not walk back through five tabs.
 */
export function useTabParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get(key);
  const value = allowed.includes(raw as T) ? (raw as T) : fallback;

  // A stale or hand-edited parameter is corrected in the URL rather than
  // silently ignored, so what the address bar says always matches the screen.
  useEffect(() => {
    if (raw !== null && !allowed.includes(raw as T)) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(key);
          return next;
        },
        { replace: true },
      );
    }
  }, [raw, allowed, key, setSearchParams]);

  const setValue = useCallback(
    (next: T) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === fallback) {
            // The default state stays out of the URL, so a shared link to the
            // page is the plain path rather than `?tab=all`.
            params.delete(key);
          } else {
            params.set(key, next);
          }
          return params;
        },
        { replace: true },
      );
    },
    [fallback, key, setSearchParams],
  );

  return [value, setValue];
}
