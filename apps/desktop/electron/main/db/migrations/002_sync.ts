/**
 * Stage 2: everything the local side of sync needs.
 *
 * Three additions, and one idea behind all of them.
 *
 * `server_seq` on every synced table records where a row stood the last time
 * the server acknowledged it. The plan called for this from day one and it was
 * missed; adding it now is exactly what migrations are for.
 *
 * `sync_outbox` is a queue of rows that have changed locally and not yet been
 * sent. It holds a *pointer*, not a copy: one entry per row, and the push reads
 * the row as it stands at that moment. Three edits to the same item before the
 * next sync therefore send once, carrying the latest state, rather than
 * replaying a history nobody needs.
 *
 * The triggers are what make it reliable. Writing to the outbox from the
 * services would mean every future service has to remember; a trigger cannot be
 * forgotten, and it fires for repairs and hand-edits too.
 *
 * The `applying` flag in `sync_state` is how rows arriving *from* the server
 * avoid being queued straight back at it. The triggers check it, and the sync
 * engine sets it while applying a batch.
 *
 * It lives in `sync_state` rather than a temp table because SQLite forbids a
 * trigger on a main-database table from referencing anything in `temp`. The
 * cost is that a crash mid-apply would leave the flag set and silently stop
 * queuing, so the connection clears it on every open.
 */

/** Rows mutate after creation, so the newest write wins. */
const MASTER_TABLES = [
  'settings',
  'users',
  'categories',
  'items',
  'customers',
  'expenses',
  // A bill is only ever changed by being voided, which flips `status`. That
  // single mutation is why it is here rather than with the append-only tables.
  'sales',
] as const;

/** Written once and never touched again, so they can never conflict. */
const EVENT_TABLES = [
  'sale_items',
  'sale_returns',
  'sale_return_items',
  'stock_movements',
  'customer_ledger_entries',
  'customer_payments',
  'audit_log',
] as const;

/**
 * `counters` is the invoice sequence, which is per-terminal and must not be
 * shared. `held_sales` is an unfinished bill on one screen, which is nobody
 * else's business. Neither syncs.
 */
const SYNCED = [...MASTER_TABLES, ...EVENT_TABLES];

/** `settings` is keyed by `key`; everything else by `id`. */
function idColumn(table: string): string {
  return table === 'settings' ? 'key' : 'id';
}

function queue(table: string, when: 'NEW' | 'OLD'): string {
  return `
    INSERT INTO sync_outbox (table_name, row_id, queued_at, attempts, status, last_error)
    VALUES ('${table}', ${when}.${idColumn(table)}, ${"strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"}, 0, 'pending', NULL)
    ON CONFLICT (table_name, row_id) DO UPDATE SET
      queued_at  = excluded.queued_at,
      attempts   = 0,
      status     = 'pending',
      last_error = NULL;`;
}

/**
 * A trigger per table per operation.
 *
 * Each is guarded by `temp.sync_applying`, so applying a pulled batch does not
 * bounce it straight back to the server as a fresh local change.
 */
function triggersFor(table: string): string {
  const guard = `WHEN NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'applying')`;
  return `
CREATE TRIGGER ${table}_sync_insert AFTER INSERT ON ${table}
${guard}
BEGIN${queue(table, 'NEW')}
END;

CREATE TRIGGER ${table}_sync_update AFTER UPDATE ON ${table}
${guard}
BEGIN${queue(table, 'NEW')}
END;

CREATE TRIGGER ${table}_sync_delete AFTER DELETE ON ${table}
${guard}
BEGIN${queue(table, 'OLD')}
END;
`;
}

export const sql = /* sql */ `

-- ---------------------------------------------------------------------------
-- Where each row stood when the server last acknowledged it
-- ---------------------------------------------------------------------------
${SYNCED.map((table) => `ALTER TABLE ${table} ADD COLUMN server_seq INTEGER;`).join('\n')}

-- ---------------------------------------------------------------------------
-- Sync bookkeeping: the pull cursor, last success, clock offset, and the
-- 'applying' flag the triggers below consult on every write
-- ---------------------------------------------------------------------------

CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- The outbox: one row per locally-changed record awaiting its turn
-- ---------------------------------------------------------------------------

CREATE TABLE sync_outbox (
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  queued_at   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  -- 'dead' means it failed repeatedly and has been set aside, so one bad row
  -- cannot block everything queued behind it.
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'dead')),
  last_error  TEXT,
  PRIMARY KEY (table_name, row_id)
);

CREATE INDEX ix_outbox_ready ON sync_outbox (status, queued_at);

-- ---------------------------------------------------------------------------
-- Conflicts the server decided against us, kept so they can be shown
-- ---------------------------------------------------------------------------

CREATE TABLE sync_conflicts (
  id          TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  mine_json   TEXT,
  theirs_json TEXT,
  detail      TEXT NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX ix_conflicts_unseen ON sync_conflicts (seen, created_at);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
${SYNCED.map(triggersFor).join('\n')}

-- Everything already in the shop's database predates sync, so it all needs
-- sending once. Queued directly rather than by touching the rows, which would
-- change their updated_at and misrepresent when the shop last edited them.
${SYNCED.map(
  (table) => `
INSERT INTO sync_outbox (table_name, row_id, queued_at, attempts, status)
SELECT '${table}', ${idColumn(table)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0, 'pending' FROM ${table};`,
).join('')}
`;

export { EVENT_TABLES, MASTER_TABLES, SYNCED, idColumn };
