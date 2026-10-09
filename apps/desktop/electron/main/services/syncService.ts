import type BetterSqlite3 from 'better-sqlite3';
import { nowIso } from '@pos/shared';

/**
 * The local side of sync: what is waiting to go, and what came back.
 *
 * This file owns the bookkeeping — the queue, the cursor, the flag that stops
 * pulled rows echoing back. The engine that talks to the server builds on top
 * of it, and the shop sees it as one line in the app chrome.
 */

// --- Bookkeeping -----------------------------------------------------------

export type SyncStateKey = 'cursor' | 'lastSyncedAt' | 'lastError' | 'clockSkewMs' | 'applying';

export function readState(db: BetterSqlite3.Database, key: SyncStateKey): string | null {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function writeState(db: BetterSqlite3.Database, key: SyncStateKey, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function clearState(db: BetterSqlite3.Database, key: SyncStateKey): void {
  db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
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
  /** True once a server has been configured; false means sync is simply off. */
  configured: boolean;
}

export function syncStatus(db: BetterSqlite3.Database, configured: boolean): SyncStatus {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
         COUNT(*) FILTER (WHERE status = 'dead')    AS dead
       FROM sync_outbox`,
    )
    .get() as { pending: number; failed: number; dead: number };

  const conflicts = db
    .prepare(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE seen = 0`)
    .get() as { n: number };

  return {
    pending: counts.pending,
    failed: counts.failed,
    dead: counts.dead,
    unseenConflicts: conflicts.n,
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
}

/**
 * The next slice of work, oldest first.
 *
 * `dead` rows are excluded: one row the server will never accept must not hold
 * up everything queued behind it.
 */
export function nextBatch(db: BetterSqlite3.Database, limit = 200): QueuedRow[] {
  const rows = db
    .prepare(
      `SELECT table_name, row_id, attempts
         FROM sync_outbox
        WHERE status IN ('pending', 'failed')
        ORDER BY queued_at, table_name, row_id
        LIMIT ?`,
    )
    .all(limit) as Array<{ table_name: string; row_id: string; attempts: number }>;

  return rows.map((row) => ({
    tableName: row.table_name,
    rowId: row.row_id,
    attempts: row.attempts,
  }));
}

/** Accepted by the server: stop tracking it. */
export function markSent(db: BetterSqlite3.Database, rows: readonly QueuedRow[]): void {
  const remove = db.prepare(`DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ?`);
  for (const row of rows) remove.run(row.tableName, row.rowId);
}

const MAX_ATTEMPTS = 10;

/**
 * Rejected: count the attempt and set it aside once it is clearly hopeless.
 *
 * Without the dead lane, one malformed row would be retried forever and
 * nothing behind it would ever be sent.
 */
export function markFailed(
  db: BetterSqlite3.Database,
  row: QueuedRow,
  error: string,
): { dead: boolean } {
  const attempts = row.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  db.prepare(
    `UPDATE sync_outbox
        SET attempts = ?, status = ?, last_error = ?
      WHERE table_name = ? AND row_id = ?`,
  ).run(attempts, dead ? 'dead' : 'failed', error.slice(0, 500), row.tableName, row.rowId);
  return { dead };
}

/** Put the dead lane back in the queue, for after a fix has been deployed. */
export function retryDead(db: BetterSqlite3.Database): number {
  const result = db
    .prepare(
      `UPDATE sync_outbox SET status = 'pending', attempts = 0, last_error = NULL
        WHERE status = 'dead'`,
    )
    .run();
  return result.changes;
}

// --- Conflicts -------------------------------------------------------------

export function recordConflict(
  db: BetterSqlite3.Database,
  input: { id: string; tableName: string; rowId: string; detail: string; mine?: unknown; theirs?: unknown },
): void {
  db.prepare(
    `INSERT INTO sync_conflicts (id, table_name, row_id, mine_json, theirs_json, detail, seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    input.id,
    input.tableName,
    input.rowId,
    input.mine === undefined ? null : JSON.stringify(input.mine),
    input.theirs === undefined ? null : JSON.stringify(input.theirs),
    input.detail,
    nowIso(),
  );
}

export interface ConflictRow {
  id: string;
  tableName: string;
  rowId: string;
  detail: string;
  createdAt: string;
}

export function listConflicts(db: BetterSqlite3.Database, limit = 50): ConflictRow[] {
  const rows = db
    .prepare(
      `SELECT id, table_name, row_id, detail, created_at
         FROM sync_conflicts ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    table_name: string;
    row_id: string;
    detail: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    tableName: row.table_name,
    rowId: row.row_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export function markConflictsSeen(db: BetterSqlite3.Database): void {
  db.prepare(`UPDATE sync_conflicts SET seen = 1 WHERE seen = 0`).run();
}
