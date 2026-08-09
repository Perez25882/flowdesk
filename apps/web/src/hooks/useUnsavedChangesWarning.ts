import { useEffect } from 'react';

/**
 * Warns before the tab is closed or reloaded with unsaved edits pending.
 *
 * Settings holds a draft of the business profile and twelve reply templates
 * that only reach the server on Save. Losing a rewritten set of customer
 * replies to an accidental refresh is a genuinely bad afternoon, and the save
 * bar alone does not help someone who has already hit reload.
 *
 * Browsers ignore any custom message here and show their own wording, so the
 * returned string is only a legacy signal that a prompt is wanted.
 */
export function useUnsavedChangesWarning(when: boolean): void {
  useEffect(() => {
    if (!when) return;

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      // Required by older Chrome and Safari to trigger the prompt at all.
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [when]);
}
