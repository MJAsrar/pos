import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SyncAuthError } from '@pos/shared';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabaseConfig.js';

/**
 * How this computer proves it is allowed to sync.
 *
 * The terminal signs in once, as its own account, and what is kept afterwards
 * is a refresh token encrypted with Windows' own credential protection
 * (`safeStorage`, DPAPI underneath). The password is never written anywhere,
 * and the token on disk is useless on another machine or to another Windows
 * user.
 *
 * What is deliberately *not* here: any key that would let this app bypass the
 * database's access rules. The publishable key it ships with grants nothing on
 * its own. Access is decided by who is signed in, which is why a stolen
 * installer is not a stolen shop.
 *
 * If the sign-in lapses, sync stops and says so — and the till keeps working.
 * Selling must never depend on the cloud.
 */

interface StoredSession {
  email: string;
  /** Encrypted refresh token, base64. Never the password. */
  token: string;
}

interface LiveToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

let live: LiveToken | null = null;
let cached: StoredSession | null | undefined;

function sessionFile(): string {
  return join(app.getPath('userData'), 'cloud-session.json');
}

function loadStored(): StoredSession | null {
  if (cached !== undefined) return cached;

  const path = sessionFile();
  if (!existsSync(path)) {
    cached = null;
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredSession;
    cached = parsed.email && parsed.token ? parsed : null;
  } catch {
    // A corrupt file means signing in again, which is a minor nuisance, not a
    // reason to refuse to start.
    cached = null;
  }
  return cached;
}

function saveStored(email: string, refreshToken: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SyncAuthError(
      'This computer cannot store the sign-in securely, so syncing is not available on it.',
    );
  }

  const stored: StoredSession = {
    email,
    token: safeStorage.encryptString(refreshToken).toString('base64'),
  };
  writeFileSync(sessionFile(), JSON.stringify(stored), 'utf8');
  cached = stored;
}

function readRefreshToken(): string | null {
  const stored = loadStored();
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored.token, 'base64'));
  } catch {
    // Written by a different Windows user, or the machine was re-imaged.
    return null;
  }
}

// --- What the rest of the app asks ----------------------------------------

/** True once a terminal has signed in. Sync does nothing until it has. */
export function isSignedIn(): boolean {
  return loadStored() !== null;
}

/** Which account this computer syncs as, for the Settings screen. */
export function cloudAccount(): string | null {
  return loadStored()?.email ?? null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
  msg?: string;
  error?: string;
}

async function tokenRequest(
  grant: 'password' | 'refresh_token',
  body: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const parsed = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok) {
    // The cloud's own wording ("Invalid login credentials") goes to the log,
    // not to the person: it tells them nothing they can act on.
    const detail = parsed.error_description ?? parsed.msg ?? parsed.error ?? '';
    console.error(`[cloud] ${grant} sign-in refused: ${response.status} ${detail}`);

    throw new SyncAuthError(
      grant === 'password'
        ? 'That email and password were not accepted. Check both and try again.'
        : 'This computer needs to be signed in to the cloud again.',
    );
  }

  return parsed;
}

/**
 * Sign this computer in. Called once, from Settings.
 *
 * The password is used here and then forgotten — only the refresh token is
 * kept, encrypted.
 */
export async function signIn(email: string, password: string): Promise<{ email: string }> {
  const parsed = await tokenRequest('password', { email, password });

  if (!parsed.access_token || !parsed.refresh_token) {
    throw new SyncAuthError('The cloud did not return a sign-in for this computer.');
  }

  saveStored(email, parsed.refresh_token);
  live = {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };

  return { email };
}

/** Stop syncing from this computer. The shop's data stays where it is. */
export function signOut(): void {
  live = null;
  cached = null;
  try {
    rmSync(sessionFile(), { force: true });
  } catch {
    // Nothing to remove, or the file is already gone.
  }
}

/** Sixty seconds of headroom, so a token never expires mid-request. */
const RENEW_BEFORE_MS = 60_000;

/**
 * A usable access token, renewing it if needed.
 *
 * Supabase hands out a new refresh token on every renewal and invalidates the
 * old one, so the new one has to be stored or the next renewal fails.
 */
export async function accessToken(): Promise<string> {
  if (live && live.expiresAt - RENEW_BEFORE_MS > Date.now()) return live.accessToken;

  const refreshToken = readRefreshToken();
  if (!refreshToken) {
    throw new SyncAuthError('This computer is not signed in to the cloud yet.');
  }

  let parsed: TokenResponse;
  try {
    parsed = await tokenRequest('refresh_token', { refresh_token: refreshToken });
  } catch (error) {
    // A refusal means the sign-in is genuinely over; being offline does not.
    if (error instanceof SyncAuthError) signOut();
    throw error;
  }

  if (!parsed.access_token || !parsed.refresh_token) {
    signOut();
    throw new SyncAuthError('This computer needs to be signed in to the cloud again.');
  }

  const email = loadStored()?.email ?? '';
  saveStored(email, parsed.refresh_token);
  live = {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };

  return live.accessToken;
}
