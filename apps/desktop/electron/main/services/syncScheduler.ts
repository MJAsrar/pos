import { getDb } from '../db/connection.js';
import { accessToken, isSignedIn } from '../sync/cloudAuth.js';
import { createSupabaseTransport } from '../sync/supabaseTransport.js';
import { uploadOffsiteBackup } from '../sync/offsiteBackup.js';
import { deviceId, runSync, type SyncRunResult } from './syncEngine.js';
import { nextBatch, readState, writeState } from './syncService.js';

/**
 * When to sync.
 *
 * A short tick that mostly does nothing: it looks at a count on a tiny indexed
 * table, and only goes to the network if there is something to send or enough
 * time has passed to be worth asking what changed elsewhere. Cheaper to reason
 * about than hooking every write, and the counter never waits on it.
 *
 * Failures back off, doubling to a five-minute ceiling. The shop's internet
 * drops for hours at a time; retrying every ten seconds through that would
 * burn the connection it is waiting for.
 */

const TICK_MS = 10_000;
const PULL_EVERY_MS = 60_000;
/** Just under a day, so it lands at roughly the same time each morning. */
const OFFSITE_EVERY_MS = 20 * 60 * 60 * 1000;
const BACKOFF_START_MS = 20_000;
const BACKOFF_CEILING_MS = 300_000;

let timer: ReturnType<typeof setInterval> | null = null;
let backoffUntil = 0;
let backoffMs = 0;
let lastRun: SyncRunResult | null = null;

const transport = createSupabaseTransport({ accessToken });

function dueForPull(): boolean {
  const last = readState(getDb(), 'lastSyncedAt');
  if (!last) return true;
  const at = Date.parse(last);
  return !Number.isFinite(at) || Date.now() - at >= PULL_EVERY_MS;
}

function hasSomethingToSend(): boolean {
  return nextBatch(getDb(), 1).length > 0;
}

/**
 * Run one exchange now, whatever the backoff says.
 *
 * Used by the tick once it has decided, and by the Settings screen's "Sync
 * now" button — when a person presses a button they should not be told to wait
 * four more minutes.
 */
export async function syncNow(): Promise<SyncRunResult> {
  if (!isSignedIn()) {
    return {
      sent: 0,
      received: 0,
      conflicts: 0,
      setAside: 0,
      rounds: 0,
      reachedServer: false,
      problem: 'This computer is not signed in to the cloud yet.',
      skipped: false,
    };
  }

  const result = await runSync({ db: getDb(), transport });
  if (result.skipped) return result;

  lastRun = result;

  if (result.problem) {
    backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_CEILING_MS) : BACKOFF_START_MS;
    backoffUntil = Date.now() + backoffMs;
  } else {
    backoffMs = 0;
    backoffUntil = 0;
    // Only once the data itself is through, and never in a way that can fail
    // the sync: the shop losing its offsite copy for a day matters far less
    // than the queue stalling.
    await offsiteBackupIfDue();
  }

  return result;
}

/**
 * Put a copy of the database offsite, about once a day.
 *
 * Separate from the local backups on purpose. Those are on the same disk in
 * the same shop; the cloud tables are a replica and cannot undo a mistake.
 * This is the one copy that covers losing the computer itself.
 */
async function offsiteBackupIfDue(): Promise<void> {
  const db = getDb();
  const last = readState(db, 'lastOffsiteAt');
  const lastAt = last ? Date.parse(last) : 0;
  if (Number.isFinite(lastAt) && Date.now() - lastAt < OFFSITE_EVERY_MS) return;

  try {
    const result = await uploadOffsiteBackup({
      db,
      accessToken,
      deviceId: deviceId(db),
    });
    writeState(db, 'lastOffsiteAt', new Date().toISOString());
    console.log(
      `[sync] offsite copy ${result.object} (${Math.round(result.bytes / 1024)} KB)` +
        (result.removed ? `, ${result.removed} old copies cleared` : ''),
    );
  } catch (cause) {
    // Logged and dropped. It will be tried again on the next successful sync.
    console.error('[sync] offsite copy failed:', cause instanceof Error ? cause.message : cause);
  }
}

export function lastSyncRun(): SyncRunResult | null {
  return lastRun;
}

async function tick(): Promise<void> {
  if (!isSignedIn()) return;
  if (Date.now() < backoffUntil) return;
  if (!hasSomethingToSend() && !dueForPull()) return;

  try {
    await syncNow();
  } catch (cause) {
    // Nothing here may throw into the event loop: an unhandled rejection in
    // the main process takes the whole app down, and the till going dark
    // because the internet hiccuped would be unforgivable.
    console.error('[sync] unexpected failure:', cause);
    backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_CEILING_MS) : BACKOFF_START_MS;
    backoffUntil = Date.now() + backoffMs;
  }
}

export function startSyncScheduler(): void {
  if (timer) return;

  // A first attempt shortly after launch, not immediately: opening the till is
  // what the first few seconds are for.
  setTimeout(() => void tick(), 5_000);
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopSyncScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Try again now — called when the machine reports it is back online. */
export function clearSyncBackoff(): void {
  backoffUntil = 0;
  backoffMs = 0;
}
