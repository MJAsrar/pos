import type BetterSqlite3 from 'better-sqlite3';
import {
  SyncAuthError,
  SyncServerError,
  inApplyOrder,
  nowIso,
  rowKey,
  uuidv7,
  type PullRow,
  type PushRow,
  type RowResult,
  type SyncTransport,
} from '@pos/shared';
import {
  applyRow,
  hasUnsentChange,
  readRowForPush,
  recomputeDerived,
} from '../db/repos/syncRepo.js';
import {
  applyingFromServer,
  clearState,
  markFailed,
  markSent,
  nextBatch,
  readState,
  recordConflict,
  writeState,
  type QueuedRow,
} from './syncService.js';

/**
 * The exchange: send what changed here, write what changed there.
 *
 * One round trip does both, because a bill and its lines have to land together
 * and because on a bad connection one request succeeds far more often than
 * eight. The loop repeats until neither side has anything left.
 *
 * Three things this has to get right, all of them about the counter not
 * noticing sync exists:
 *
 * Selling continues during the round trip. A row edited while the server was
 * answering must not be dropped from the queue on the strength of an
 * acknowledgement for the older version — `markSent` compares `queued_at`.
 *
 * Being offline is not a failure. It costs a row nothing; only an actual
 * refusal from the server counts against it. Otherwise a week of bad internet
 * would come back to a queue full of rows marked dead.
 *
 * One bad row must not block the rest. The server names the row it choked on,
 * that row is set aside for this run, and everything behind it goes.
 */

const PUSH_BATCH = 100;
const PULL_LIMIT = 500;

/** Enough for 20,000 rows in one run; the loop normally ends after one or two. */
const MAX_ROUNDS = 40;

export interface SyncDeps {
  db: BetterSqlite3.Database;
  transport: SyncTransport;
  /** Clock, injectable so tests do not depend on the wall clock. */
  now?: () => string;
}

export interface SyncRunResult {
  /** Rows the server accepted. */
  sent: number;
  /** Rows written from the server. */
  received: number;
  /** Edits the server decided against, kept for the owner to look at. */
  conflicts: number;
  /** Rows set aside this run after repeated refusals. */
  setAside: number;
  rounds: number;
  /** True if the server answered at all, however it answered. */
  reachedServer: boolean;
  /** What to tell the shop, in its own words. Null when all is well. */
  problem: string | null;
  /** True when a sync was already in flight and this call did nothing. */
  skipped: boolean;
}

/** Only one exchange at a time, per database. */
const inFlight = new WeakSet<BetterSqlite3.Database>();

export function syncInFlight(db: BetterSqlite3.Database): boolean {
  return inFlight.has(db);
}

/** This machine's name on the wire, minted once and kept out of sync. */
export function deviceId(db: BetterSqlite3.Database): string {
  const existing = readState(db, 'deviceId');
  if (existing) return existing;
  const minted = uuidv7();
  writeState(db, 'deviceId', minted);
  return minted;
}

export async function runSync(deps: SyncDeps): Promise<SyncRunResult> {
  const { db } = deps;

  if (inFlight.has(db)) {
    return {
      sent: 0,
      received: 0,
      conflicts: 0,
      setAside: 0,
      rounds: 0,
      reachedServer: false,
      problem: null,
      skipped: true,
    };
  }

  inFlight.add(db);
  try {
    return await exchangeUntilDone(deps);
  } finally {
    inFlight.delete(db);
  }
}

async function exchangeUntilDone(deps: SyncDeps): Promise<SyncRunResult> {
  const { db, transport } = deps;
  const now = deps.now ?? nowIso;
  const device = deviceId(db);

  /** Rows the server refused outright this run, held back so the rest can go. */
  const setAsideKeys = new Set<string>();

  const result: SyncRunResult = {
    sent: 0,
    received: 0,
    conflicts: 0,
    setAside: 0,
    rounds: 0,
    reachedServer: false,
    problem: null,
    skipped: false,
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    result.rounds = round + 1;

    const queued = nextBatch(db, PUSH_BATCH + setAsideKeys.size)
      .filter((row) => !setAsideKeys.has(rowKey(row.tableName, row.rowId)))
      .slice(0, PUSH_BATCH);

    const batchWasFull = queued.length === PUSH_BATCH;
    const changes = buildChanges(db, queued);
    const cursor = Number(readState(db, 'cursor') ?? 0);

    let response;
    try {
      response = await transport.exchange({
        deviceId: device,
        clientTime: now(),
        cursor,
        changes,
        pullLimit: PULL_LIMIT,
      });
      result.reachedServer = true;
    } catch (error) {
      if (error instanceof SyncAuthError) {
        result.reachedServer = true;
        result.problem = error.message;
        writeState(db, 'lastError', error.message);
        return result;
      }

      if (error instanceof SyncServerError) {
        result.reachedServer = true;

        // The server named the row it could not save. Count it against that
        // row, hold it back, and send everything else on the next round.
        const named = error.row
          ? queued.find((row) => row.tableName === error.row?.table && row.rowId === error.row.id)
          : undefined;

        if (named) {
          const { dead } = markFailed(db, named, error.message);
          if (dead) result.setAside++;
          setAsideKeys.add(rowKey(named.tableName, named.rowId));
          continue;
        }

        result.problem = error.message;
        writeState(db, 'lastError', error.message);
        return result;
      }

      // Could not reach the server. Nothing is wrong with the queue.
      result.problem = 'No internet connection, so nothing could be sent yet.';
      writeState(db, 'lastError', result.problem);
      return result;
    }

    const applied = applyResponse(db, queued, response.results, response.changes, response.cursor);
    result.sent += applied.sent;
    result.received += applied.received;
    result.conflicts += applied.conflicts;
    result.setAside += applied.setAside;
    for (const key of applied.setAsideKeys) setAsideKeys.add(key);

    if (!response.hasMore && !batchWasFull) break;
  }

  writeState(db, 'lastSyncedAt', now());
  clearState(db, 'lastError');
  return result;
}

/**
 * Read each queued row as it stands now.
 *
 * Parents first, so the server sees a bill before its lines. The outbox is
 * ordered by time and then table name, and `sale_items` sorts before `sales`.
 */
function buildChanges(db: BetterSqlite3.Database, queued: readonly QueuedRow[]): PushRow[] {
  const rows: PushRow[] = [];

  for (const entry of queued) {
    const candidate = readRowForPush(db, entry.tableName, entry.rowId);

    if (!candidate.data) {
      // Gone from this database entirely. Travels as a delete so the other
      // side learns it is gone rather than keeping it forever.
      rows.push({
        table: entry.tableName,
        id: entry.rowId,
        deleted: true,
        updatedAt: nowIso(),
        data: {},
      });
      continue;
    }

    rows.push({
      table: entry.tableName,
      id: entry.rowId,
      deleted: false,
      updatedAt: candidate.updatedAt ?? nowIso(),
      data: candidate.data,
    });
  }

  return inApplyOrder(rows);
}

interface AppliedCounts {
  sent: number;
  received: number;
  conflicts: number;
  setAside: number;
  setAsideKeys: string[];
}

/**
 * Write the whole response in one transaction.
 *
 * The cursor advances only if everything in the page landed. A half-applied
 * page with an advanced cursor would lose rows permanently, which is the one
 * outcome worth any amount of care to avoid.
 */
function applyResponse(
  db: BetterSqlite3.Database,
  queued: readonly QueuedRow[],
  results: readonly RowResult[],
  changes: readonly PullRow[],
  cursor: number,
): AppliedCounts {
  const counts: AppliedCounts = {
    sent: 0,
    received: 0,
    conflicts: 0,
    setAside: 0,
    setAsideKeys: [],
  };

  const byKey = new Map(queued.map((row) => [rowKey(row.tableName, row.rowId), row]));

  return applyingFromServer(db, () =>
    db.transaction(() => {
      // Foreign keys are checked at commit instead of per statement, so a
      // page that happens to carry a bill's lines before the bill is fine.
      db.pragma('defer_foreign_keys = ON');

      const accepted: QueuedRow[] = [];

      for (const outcome of results) {
        const entry = byKey.get(rowKey(outcome.table, outcome.id));
        if (!entry) continue;

        if (outcome.status === 'ok') {
          accepted.push(entry);
          continue;
        }

        if (outcome.status === 'conflict') {
          // The server kept someone else's version and is sending it to us in
          // this same response. Stop trying to push ours, and keep a note so
          // the owner can see what was overruled.
          recordConflict(db, {
            tableName: outcome.table,
            rowId: outcome.id,
            detail: outcome.reason ?? 'This was changed somewhere else more recently.',
            mine: readRowForPush(db, outcome.table, outcome.id).data,
          });
          accepted.push(entry);
          counts.conflicts++;
          continue;
        }

        // Rejected: something about the row itself. Count it and hold it back,
        // so the rows behind it still go.
        const { dead } = markFailed(db, entry, outcome.reason ?? 'The server refused this change.');
        if (dead) counts.setAside++;
        counts.setAsideKeys.push(rowKey(outcome.table, outcome.id));
      }

      counts.sent = markSent(db, accepted);

      const itemIds: string[] = [];
      const customerIds: string[] = [];

      for (const row of inApplyOrder(changes)) {
        // The server sends back what it was just given. If this row has been
        // edited again since, writing the echo would quietly undo that edit —
        // so leave it, and let the next round push the newer version.
        if (hasUnsentChange(db, row.table, row.id)) continue;

        applyRow(db, row.table, row.id, row.data);
        counts.received++;

        if (row.table === 'items') itemIds.push(row.id);
        if (row.table === 'customers') customerIds.push(row.id);
        if (row.table === 'stock_movements' && typeof row.data.item_id === 'string') {
          itemIds.push(row.data.item_id);
        }
        if (row.table === 'customer_ledger_entries' && typeof row.data.customer_id === 'string') {
          customerIds.push(row.data.customer_id);
        }
      }

      // Stock and balances are sums of the rows that just landed, never
      // figures sent over the wire. This is where they are put back in step.
      recomputeDerived(db, { itemIds, customerIds });

      writeState(db, 'cursor', String(cursor));

      return counts;
    })(),
  );
}
