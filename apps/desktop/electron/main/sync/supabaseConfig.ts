/**
 * Where the shop's cloud copy lives.
 *
 * Both values here are public by design. The project URL is just an address,
 * and the publishable key is meant to be embedded in client applications —
 * Supabase ships it in browser bundles as a matter of course. Neither grants
 * access to anything on its own: row-level security decides what a request may
 * read or write, based on who is signed in.
 *
 * What must never appear in this file, the repository, or a chat message:
 *   - the `service_role` key, which bypasses row-level security entirely
 *   - the Postgres password, which is full superuser access to the database
 *
 * The terminal's own sign-in credentials are not here either. They are entered
 * once in Settings and the refresh token is kept in Windows' encrypted
 * credential store, so pulling them out of the installer is not possible.
 */

export const SUPABASE_URL = 'https://tjanpttaenyqidoltlpk.supabase.co';

export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_9z0NURwmeUfH4lMWUZ7fAA_dZMOSsHB';

/** False until a terminal has been signed in, which is what actually enables sync. */
export function isCloudConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_PUBLISHABLE_KEY.length > 0;
}
