/**
 * Open, paused, or closed — the three things an account can be.
 *
 * This existed as one boolean, `active`, and that is precisely why the owner
 * could not pause their shop: sign-in refuses any account with `active: false`,
 * so pausing that way would have locked them out of the shop they were trying
 * to come back to. Pausing gets its own timestamp, and the rules for reading
 * all three live here so sign-in, the delivery gate and the dashboard cannot
 * come to different conclusions about the same shop.
 */

export type AccountState = 'open' | 'paused' | 'closed';

export interface AccountFlags {
  active: boolean;
  /** Set when the owner paused the shop themselves. Cleared when they return. */
  deactivatedAt: Date | null;
  /** Set when the owner closed the account for good. */
  deletedAt: Date | null;
}

/**
 * Deletion is checked first and wins over everything.
 *
 * `active: false` with no deletion is the pre-existing billing suspension, which
 * is not an owner's pause and must not be undone by signing in — so it reads as
 * closed here and stays refused by the suspension message sign-in already has.
 */
export function accountState(flags: AccountFlags): AccountState {
  if (flags.deletedAt) return 'closed';
  if (!flags.active) return 'closed';
  if (flags.deactivatedAt) return 'paused';
  return 'open';
}

/**
 * A paused owner may sign in. That is how they unpause: there is nowhere else
 * to do it from, and a pause nobody can undo is not a pause.
 */
export function canSignIn(state: AccountState): boolean {
  return state !== 'closed';
}

/**
 * Whether anything may be sent to a customer in the shop's name.
 *
 * A paused shop keeps receiving messages — customers do not know it is paused —
 * but nothing answers them automatically until the owner comes back. Answering
 * on behalf of a shop that has stepped away is the thing pausing exists to
 * prevent.
 */
export function assistantMaySpeak(state: AccountState): boolean {
  return state === 'open';
}
