import { describe, expect, it } from 'vitest';
import { accountState, canSignIn, assistantMaySpeak } from '../src/modules/auth/account-state.js';

/**
 * Whether an account is open, paused by its owner, or closed.
 *
 * Three states that were previously one boolean, which is why pausing could not
 * be built: sign-in refuses any account with `active: false`, so a "pause for a
 * while" implemented that way would have locked the owner out of their own shop
 * permanently. Pausing is therefore its own field, and the rules live here
 * rather than being re-derived at each call site — sign-in, the delivery gate
 * and the dashboard all have to agree about what a paused shop is.
 */

const OPEN = { active: true, deactivatedAt: null, deletedAt: null };
const PAUSED = { active: true, deactivatedAt: new Date('2026-09-20T10:00:00Z'), deletedAt: null };
const CLOSED = { active: false, deactivatedAt: null, deletedAt: new Date('2026-09-20T10:00:00Z') };

describe('accountState', () => {
  it('reads an ordinary shop as open', () => {
    expect(accountState(OPEN)).toBe('open');
  });

  it('reads a shop the owner paused as paused', () => {
    expect(accountState(PAUSED)).toBe('paused');
  });

  it('reads a deleted shop as closed', () => {
    expect(accountState(CLOSED)).toBe('closed');
  });

  it('treats a deleted shop as closed even if it is still flagged active', () => {
    // Deletion sets both. If a future change sets only one, deletion must still
    // win — the opposite mistake would let a closed account back in.
    expect(accountState({ active: true, deactivatedAt: null, deletedAt: new Date() })).toBe(
      'closed',
    );
  });

  it('treats deletion as final even if the shop was paused first', () => {
    expect(accountState({ active: false, deactivatedAt: new Date(), deletedAt: new Date() })).toBe(
      'closed',
    );
  });

  it('reads a suspended-for-billing shop as closed to sign-in, not paused', () => {
    // `active: false` without a deletion is the billing suspension that already
    // existed. It is not an owner's pause and must not be undone by simply
    // signing in.
    expect(accountState({ active: false, deactivatedAt: null, deletedAt: null })).toBe('closed');
  });
});

describe('canSignIn', () => {
  it('lets a paused owner back in, because that is how they unpause', () => {
    expect(canSignIn('paused')).toBe(true);
  });

  it('lets an open owner in', () => {
    expect(canSignIn('open')).toBe(true);
  });

  it('refuses a closed account', () => {
    expect(canSignIn('closed')).toBe(false);
  });
});

describe('assistantMaySpeak', () => {
  it('stays silent while the shop is paused', () => {
    // The point of pausing. Customers can still write; nothing answers them in
    // the shop's name until the owner comes back.
    expect(assistantMaySpeak('paused')).toBe(false);
  });

  it('stays silent for a closed shop', () => {
    expect(assistantMaySpeak('closed')).toBe(false);
  });

  it('speaks for an open shop', () => {
    expect(assistantMaySpeak('open')).toBe(true);
  });
});
