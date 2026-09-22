import { useEffect, useState } from 'react';

/**
 * A value that settles `ms` after it stops changing.
 *
 * For search boxes that query the server: without it every keystroke is a
 * request, and typing "Kwame" fires five searches of which four are thrown
 * away — and they can arrive out of order, briefly showing results for "Kwam".
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}
