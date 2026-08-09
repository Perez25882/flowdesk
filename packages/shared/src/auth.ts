/**
 * Credential rules shared by the API and the dashboard.
 *
 * The two had drifted: every sign-up form asked for ten characters while the
 * staff-invite endpoint accepted six, so the accounts most likely to be used on
 * a shared phone were also the ones allowed the weakest password.
 */

/** Minimum password length for owners and staff alike. */
export const MIN_PASSWORD_LENGTH = 10;
