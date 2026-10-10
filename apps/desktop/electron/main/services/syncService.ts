import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7 } from '@pos/shared';
import {
  countByStatus,
  countUnseenConflicts,
  deleteQueuedIfUnchanged,
  deleteStateValue,
  insertConflict,
  markAllConflictsSeen,
  readStateValue,
  requeueDead,
  selectConflicts,
  selectQueued,
  updateQueuedFailure,
  writeStateValue,
} from '../db/repos/syncRepo.js';

/**
 * The local side of sync: what is waiting to go, and what came back.
 *
 * This file owns the rules — how many failures before a row is set aside, what
 * the shop is told, how pulled rows are kept from echoing back. The queries
 * live in `db/repos/syncRepo.ts`; the engine that talks to the server builds on
 * top of both.
 */

// --- Bookkeeping -----------------------------------------------------------

export type SyncStateKey =
  | 'cursor'
  | 'lastSyncedAt'
  | 'lastError'
  | 'clockSkewMs'
  | 'applying'
  /** When a copy of the database last went offsite. */
  | 'lastOffsiteAt'
  /** This machine's name on the wire. Stored here because `sync_state` is one
   *  of the two tables that never sync, and a device id must not be shared. */
  | 'deviceId';

export function readState(db: BetterSqlite3.Database, key: SyncStateKey): string | null {
  return readStateValue(db, key);
}

export function writeState(db: BetterSqlite3.Database, key: SyncStateKey, value: string): void {
  writeStateValue(db, key, value);
}

export function clearState(db: BetterSqlite3.Database, key: SyncStateKey): void {
  deleteStateValue(db, key);
}

/**
 * Run work as a batch arriving from the server.
 *
 * While the flag is set the outbox triggers stand down, so applying a pulled
 * row does not look like a local edit and bounce straight back. The `finally`
 * matters more than it looks: a flag left set would silently stop queuing
 * every later change, and the shop would drift out of sync with nothing
 * appearing to be wrong.
 */
export function applyingFromServer<T>(db: BetterSqlite3.Database, work: () => T): T {
  writeState(db, 'applying', '1');
  try {
    return work();
  } finally {
    clearState(db, 'applying');
  }
}

// --- What the shop sees ----------------------------------------------------

export interface SyncStatus {
  /** Rows waiting to be sent. */
  pending: number;
  /** Rows that failed and will be tried again. */
  failed: number;
  /** Rows set aside after repeated failures, so they block nothing. */
  dead: number;
  /** Conflicts the server decided against us that nobody has looked at. */
  unseenConflicts: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** True once a terminal is signed in; false means sync is simply off. */
  configured: boolean;
}

export function syncStatus(db: BetterSqlite3.Database, configured: boolean): SyncStatus {
  const counts = countByStatus(db);

  return {
    pending: counts.pending,
    failed: counts.failed,
    dead: counts.dead,
    unseenConflicts: countUnseenConflicts(db),
    lastSyncedAt: readState(db, 'lastSyncedAt'),
    lastError: readState(db, 'lastError'),
    configured,
  };
}

// --- The queue -------------------------------------------------------------

export interface QueuedRow {
  tableName: string;
  rowId: string;
  attempts: number;
  /** When the trigger last queued it. Used to detect a change made mid-sync. */
  queuedAt: string;
}

/**
 * The next slice of work, oldest first.
 *
 * `dead` rows are excluded: one row the server will never accept must not hold
 * up everything queued behind it.
 */
export function nextBatch(db: BetterSqlite3.Database, limit = 200): QueuedRow[] {
  return selectQueued(db, limit).map((row) => ({
    tableName: row.table_name,
    rowId: row.row_id,
    attempts: row.attempts,
    queuedAt: row.queued_at,
  }));
}

/**
 * Accepted by the server: stop tracking it.
 *
 * Returns how many were actually dropped. A row edited again while the server
 * was answering stays queued, so the newer edit is not lost.
 */
export function markSent(db: BetterSqlite3.Database, rows: readonly QueuedRow[]): number {
  let dropped = 0;
  for (const row of rows) {
    if (deleteQueuedIfUnchanged(db, row.tableName, row.rowId, row.queuedAt)) dropped++;
  }
  return dropped;
}

export const MAX_ATTEMPTS = 10;

/**
 * Rejected: count the attempt and set it aside once it is clearly hopeless.
 *
 * Only a refusal from the server counts. Being offline does not, or a shop
 * with a week of bad internet would come back to a queue full of rows marked
 * dead — without the dead lane, though, one malformed row would be retried
 * forever and nothing behind it would ever be sent.
 */
export function markFailed(
  db: BetterSqlite3.Database,
  row: QueuedRow,
  error: string,
): { dead: boolean } {
  const attempts = row.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  updateQueuedFailure(
    db,
    row.tableName,
    row.rowId,
    row.queuedAt,
    attempts,
    dead ? 'dead' : 'failed',
    error.slice(0, 500),
  );
  return { dead };
}

/** Put the dead lane back in the queue, for after a fix has been deployed. */
export function retryDead(db: BetterSqlite3.Database): number {
  return requeueDead(db);
}

// --- Conflicts -------------------------------------------------------------

export function recordConflict(
  db: BetterSqlite3.Database,
  input: {
    id?: string;
    tableName: string;
    rowId: string;
    detail: string;
    mine?: unknown;
    theirs?: unknown;
  },
): void {
  insertConflict(db, {
    id: input.id ?? uuidv7(),
    tableName: input.tableName,
    rowId: input.rowId,
    mineJson: input.mine === undefined ? null : JSON.stringify(input.mine),
    theirsJson: input.theirs === undefined ? null : JSON.stringify(input.theirs),
    detail: input.detail,
    createdAt: nowIso(),
  });
}

export interface ConflictRow {
  id: string;
  tableName: string;
  rowId: string;
  detail: string;
  createdAt: string;
}

/**
 * Clashes to show the owner.
 *
 * Only the ones nobody has looked at, by default. The screen that shows these
 * has a button saying "I have seen these" — if the list kept them afterwards,
 * pressing it would appear to do nothing.
 */
export function listConflicts(
  db: BetterSqlite3.Database,
  limit = 50,
  options: { includeSeen?: boolean } = {},
): ConflictRow[] {
  return selectConflicts(db, limit, !options.includeSeen).map((row) => ({
    id: row.id,
    tableName: row.table_name,
    rowId: row.row_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export function markConflictsSeen(db: BetterSqlite3.Database): void {
  markAllConflictsSeen(db);
}
