import type BetterSqlite3 from 'better-sqlite3';
import { DERIVED_COLUMNS, stripUnsyncable } from '@pos/shared';

/**
 * Every query sync needs, and nothing else.
 *
 * The engine decides *what* to send and *when*; this file is the only place
 * that knows how rows are actually stored. Same reason as the other repos:
 * when the website talks to Postgres instead of SQLite, the engine does not
 * change.
 *
 * One thing here is load-bearing and easy to miss. Rows arriving from the
 * server are written column by column, using only the columns the payload
 * actually carries. `qty_on_hand` and `balance` are excluded always — they are
 * running sums of the movement and ledger rows, and a figure arriving from
 * elsewhere could wipe out a day of offline sales. They are recomputed from
 * the rows themselves, after the batch lands.
 */

/** `settings` is keyed by `key`; everything else by `id`. */
export function idColumn(table: string): string {
  return table === 'settings' ? 'key' : 'id';
}

const columnCache = new WeakMap<BetterSqlite3.Database, Map<string, string[]>>();

/** The columns this database actually has, which may differ from the server's. */
export function localColumns(db: BetterSqlite3.Database, table: string): string[] {
  let perDb = columnCache.get(db);
  if (!perDb) {
    perDb = new Map();
    columnCache.set(db, perDb);
  }
  const cached = perDb.get(table);
  if (cached) return cached;

  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
    name: string;
  }>;
  const names = rows.map((row) => row.name);
  perDb.set(table, names);
  return names;
}

// --- Reading a row to send -------------------------------------------------

export interface PushCandidate {
  table: string;
  id: string;
  /** Null when the row is no longer here, which travels as a delete. */
  data: Record<string, unknown> | null;
  updatedAt: string | null;
}

/**
 * The row as it stands right now.
 *
 * The outbox holds a pointer, not a copy, so three edits before the next sync
 * send once and send the latest state.
 */
export function readRowForPush(
  db: BetterSqlite3.Database,
  table: string,
  id: string,
): PushCandidate {
  if (!localColumns(db, table).length) {
    return { table, id, data: null, updatedAt: null };
  }

  const row = db
    .prepare(`SELECT * FROM ${table} WHERE ${idColumn(table)} = ?`)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return { table, id, data: null, updatedAt: null };

  const data = stripUnsyncable(table, row);
  // `sale_items` and `sale_return_items` carry no timestamps of their own —
  // they are part of the bill above them and never change — so fall back.
  const updatedAt =
    (typeof row.updated_at === 'string' && row.updated_at) ||
    (typeof row.created_at === 'string' && row.created_at) ||
    null;

  return { table, id, data, updatedAt };
}

// --- Writing a row that arrived --------------------------------------------

/** A value SQLite will accept. */
function bindable(value: unknown): string | number | bigint | Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  // Nothing in this schema is a nested structure, but a column added later
  // might be; storing the JSON beats throwing away the row.
  return JSON.stringify(value);
}

export interface AppliedRow {
  table: string;
  id: string;
}

/**
 * Write one row from the server.
 *
 * Only the columns the payload carries are touched. A column this payload does
 * not mention keeps its local value, which is what lets the counter PC stay on
 * an older version of the app than the database.
 *
 * Must be called inside a transaction with the `applying` flag set, or the row
 * will be queued straight back at the server.
 */
export function applyRow(
  db: BetterSqlite3.Database,
  table: string,
  id: string,
  data: Record<string, unknown>,
): void {
  const key = idColumn(table);
  const derived = new Set(DERIVED_COLUMNS[table] ?? []);
  const columns = localColumns(db, table).filter(
    (column) => column in data && !derived.has(column),
  );

  if (!columns.length) return;

  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(id) !== undefined;

  if (exists) {
    const assignments = columns.filter((column) => column !== key);
    if (!assignments.length) return;
    db.prepare(
      `UPDATE ${table} SET ${assignments.map((c) => `${c} = ?`).join(', ')} WHERE ${key} = ?`,
    ).run(...assignments.map((column) => bindable(data[column])), id);
    return;
  }

  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => bindable(data[column])));
}

// --- Putting the cached totals back in step --------------------------------

/**
 * Rebuild `qty_on_hand` and `balance` from the rows they are sums of.
 *
 * A sale made on the website arrives here as its movements and ledger entries.
 * Those are the truth; the two cached columns have to be recomputed or the
 * counter would show stock that was sold elsewhere. This is the same
 * arithmetic `recordMovement` and `appendLedgerEntry` do one row at a time,
 * applied to whatever just landed.
 *
 * Deliberately leaves `updated_at` alone: recomputing a cache is not an edit
 * to the item, and stamping it would misreport when the shop last changed it.
 */
export function recomputeDerived(
  db: BetterSqlite3.Database,
  affected: { itemIds: Iterable<string>; customerIds: Iterable<string> },
): void {
  const itemIds = [...new Set(affected.itemIds)];
  const customerIds = [...new Set(affected.customerIds)];

  if (itemIds.length) {
    const update = db.prepare(
      `UPDATE items
          SET qty_on_hand = (
                SELECT ROUND(COALESCE(SUM(qty_delta), 0), 3)
                  FROM stock_movements
                 WHERE item_id = items.id AND deleted_at IS NULL)
        WHERE id = ?`,
    );
    for (const id of itemIds) update.run(id);
  }

  if (customerIds.length) {
    const update = db.prepare(
      `UPDATE customers
          SET balance = (
                SELECT COALESCE(SUM(amount), 0)
                  FROM customer_ledger_entries
                 WHERE customer_id = customers.id AND deleted_at IS NULL)
        WHERE id = ?`,
    );
    for (const id of customerIds) update.run(id);
  }
}

// --- Keeping the local numbering past what arrived ------------------------

/**
 * Move a counter forward, never back.
 *
 * `counters` is one of the two tables that never sync: the invoice sequence is
 * per-computer so it keeps working with no connection. The cost is that a
 * computer which has just joined an existing shop holds bills it did not mint
 * while its own counter is still at zero, and its first sale would claim a
 * number already used. The unique index refuses it and the sale fails.
 *
 * So after bills arrive, the counter is pulled up past them. Guarded with
 * `value <`, because a counter must never go backwards — two bills with the
 * same number is the thing being avoided.
 */
export function advanceCounter(db: BetterSqlite3.Database, name: string, atLeast: number): void {
  db.prepare(`UPDATE counters SET value = ? WHERE name = ? AND value < ?`).run(
    atLeast,
    name,
    atLeast,
  );
}

// --- Bookkeeping -----------------------------------------------------------

export function readStateValue(db: BetterSqlite3.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function writeStateValue(db: BetterSqlite3.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteStateValue(db: BetterSqlite3.Database, key: string): void {
  db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
}

// --- The outbox ------------------------------------------------------------

export interface OutboxRow {
  table_name: string;
  row_id: string;
  attempts: number;
  queued_at: string;
}

export function selectQueued(db: BetterSqlite3.Database, limit: number): OutboxRow[] {
  return db
    .prepare(
      `SELECT table_name, row_id, attempts, queued_at
         FROM sync_outbox
        WHERE status IN ('pending', 'failed')
        ORDER BY queued_at, table_name, row_id
        LIMIT ?`,
    )
    .all(limit) as OutboxRow[];
}

/**
 * Stop tracking a row, unless it changed again while the server was answering.
 *
 * The sync round trip is a network call, and the counter keeps selling during
 * it. If an item is edited after its row was read and before the
 * acknowledgement comes back, the trigger has already re-queued it with a new
 * `queued_at` — and deleting the entry here would throw that newer edit away
 * silently. Matching on `queued_at` means the second edit stays queued.
 */
/**
 * Whether this row has a local change the server has not accepted yet.
 *
 * Checked before writing a row that arrived from the server. The server echoes
 * back what it was just sent, and if the counter edited that row again in the
 * meantime, writing the echo would undo the newer edit — and then push the old
 * value back, so the shop would watch its change revert for no visible reason.
 *
 * Rows in the dead lane are not counted: their change is never going to be
 * accepted, so the version from elsewhere is the better one to keep.
 */
export function hasUnsentChange(db: BetterSqlite3.Database, table: string, id: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sync_outbox
          WHERE table_name = ? AND row_id = ? AND status IN ('pending', 'failed')`,
      )
      .get(table, id) !== undefined
  );
}

export function deleteQueuedIfUnchanged(
  db: BetterSqlite3.Database,
  table: string,
  id: string,
  queuedAt: string,
): boolean {
  return (
    db
      .prepare(
        `DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ? AND queued_at = ?`,
      )
      .run(table, id, queuedAt).changes > 0
  );
}

/** Same reasoning: a row that changed again deserves a fresh attempt count. */
export function updateQueuedFailure(
  db: BetterSqlite3.Database,
  table: string,
  id: string,
  queuedAt: string,
  attempts: number,
  status: 'failed' | 'dead',
  error: string,
): void {
  db.prepare(
    `UPDATE sync_outbox
        SET attempts = ?, status = ?, last_error = ?
      WHERE table_name = ? AND row_id = ? AND queued_at = ?`,
  ).run(attempts, status, error, table, id, queuedAt);
}

export function requeueDead(db: BetterSqlite3.Database): number {
  return db
    .prepare(
      `UPDATE sync_outbox SET status = 'pending', attempts = 0, last_error = NULL
        WHERE status = 'dead'`,
    )
    .run().changes;
}

export function countByStatus(db: BetterSqlite3.Database): {
  pending: number;
  failed: number;
  dead: number;
} {
  return db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
         COUNT(*) FILTER (WHERE status = 'dead')    AS dead
       FROM sync_outbox`,
    )
    .get() as { pending: number; failed: number; dead: number };
}

// --- Conflicts -------------------------------------------------------------

export function insertConflict(
  db: BetterSqlite3.Database,
  row: {
    id: string;
    tableName: string;
    rowId: string;
    mineJson: string | null;
    theirsJson: string | null;
    detail: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO sync_conflicts (id, table_name, row_id, mine_json, theirs_json, detail, seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    row.id,
    row.tableName,
    row.rowId,
    row.mineJson,
    row.theirsJson,
    row.detail,
    row.createdAt,
  );
}

export function selectConflicts(
  db: BetterSqlite3.Database,
  limit: number,
  unseenOnly: boolean,
): Array<{
  id: string;
  table_name: string;
  row_id: string;
  detail: string;
  created_at: string;
}> {
  return db
    .prepare(
      `SELECT id, table_name, row_id, detail, created_at
         FROM sync_conflicts
        ${unseenOnly ? 'WHERE seen = 0' : ''}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    table_name: string;
    row_id: string;
    detail: string;
    created_at: string;
  }>;
}

export function countUnseenConflicts(db: BetterSqlite3.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE seen = 0`).get() as {
    n: number;
  };
  return row.n;
}

export function markAllConflictsSeen(db: BetterSqlite3.Database): void {
  db.prepare(`UPDATE sync_conflicts SET seen = 1 WHERE seen = 0`).run();
}
