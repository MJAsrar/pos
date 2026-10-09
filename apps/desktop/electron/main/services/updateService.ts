import { app } from 'electron';
import pkg from 'electron-updater';

const { autoUpdater } = pkg;

/**
 * Automatic updates.
 *
 * Two rules, both about not interrupting a shop that is open. A downloaded
 * update is never installed while the app is running — it is applied the next
 * time the counter closes the app, so the screen can never disappear mid-sale.
 * And every failure is swallowed: the shop's internet is unreliable, and a
 * missed update check must never stop anyone selling.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export interface UpdateState {
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  version: string | null;
  error: string | null;
  lastCheckedAt: string | null;
}

const state: UpdateState = {
  checking: false,
  available: false,
  downloaded: false,
  version: null,
  error: null,
  lastCheckedAt: null,
};

export function updateState(): UpdateState {
  return { ...state };
}

export function startUpdateChecks(): void {
  // In development there is no packaged app to replace.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // The installer runs on quit, never by restarting the app underneath the user.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    state.checking = true;
    state.error = null;
  });

  autoUpdater.on('update-available', (info) => {
    state.checking = false;
    state.available = true;
    state.version = info.version;
    console.log(`[update] ${info.version} available, downloading in the background`);
  });

  autoUpdater.on('update-not-available', () => {
    state.checking = false;
    state.available = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    state.downloaded = true;
    state.version = info.version;
    console.log(`[update] ${info.version} ready; it will install when the app is next closed`);
  });

  autoUpdater.on('error', (error) => {
    state.checking = false;
    // Expected most days: the shop is offline, or no release has been published
    // yet. Keep only the first line — the full body is a wall of HTTP headers
    // that nobody at a counter needs to read.
    state.error = summarise(error);
    console.log(`[update] check failed (not a problem): ${state.error}`);
  });

  void check();
  timer = setInterval(() => void check(), SIX_HOURS);
}

export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** First line only, capped — enough to diagnose, short enough to display. */
function summarise(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n')[0]?.trim() ?? 'Update check failed';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

async function check(): Promise<void> {
  try {
    state.lastCheckedAt = new Date().toISOString();
    await autoUpdater.checkForUpdates();
  } catch {
    // Already reported through the error handler above.
  }
}
