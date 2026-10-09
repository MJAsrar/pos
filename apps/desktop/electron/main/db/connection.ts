import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_SETTINGS, nowIso } from '@pos/shared';
import { databasePath } from '../paths.js';
import { migrate, type MigrationResult } from './migrate.js';

let db: BetterSqlite3.Database | null = null;
let lastMigration: MigrationResult | null = null;

/**
 * Open the shop database, apply pending migrations and seed defaults.
 *
 * Called once, from the main process, before any window exists. The renderer
 * never sees this handle — it reaches the data only through vetted IPC ops.
 */
export function openDatabase(path: string = databasePath()): BetterSqlite3.Database {
  if (db) return db;

  const connection = new Database(path);

  // WAL lets a long report read while a sale is being written, instead of the
  // counter freezing behind a reporting query.
  connection.pragma('journal_mode = WAL');
  // FULL rather than NORMAL: mains power in Dina is not dependable, and losing
  // the last committed sale to a power cut is not an acceptable trade for speed.
  connection.pragma('synchronous = FULL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');

  lastMigration = migrate(connection, path);

  // A crash while applying a batch from the server would leave the 'applying'
  // flag set, and every later local change would silently stop being queued.
  // Clearing it on open makes that impossible to inherit.
  connection.prepare(`DELETE FROM sync_state WHERE key = 'applying'`).run();
  seedDefaults(connection);

  db = connection;
  return db;
}

export function getDb(): BetterSqlite3.Database {
  if (!db) throw new Error('Database has not been opened yet.');
  return db;
}

/** What the last `openDatabase` call had to migrate, for the startup log. */
export function migrationResult(): MigrationResult | null {
  return lastMigration;
}

export function closeDatabase(): void {
  if (!db) return;
  // Fold the WAL back into the main file so a copied .db is complete on its own.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // A checkpoint failure must not stop the app from closing.
  }
  db.close();
  db = null;
}

/** True when no user exists yet, so the app should run first-time setup. */
export function needsSetup(connection: BetterSqlite3.Database = getDb()): boolean {
  const row = connection
    .prepare(`SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL`)
    .get() as { count: number };
  return row.count === 0;
}

function seedDefaults(connection: BetterSqlite3.Database): void {
  const insert = connection.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO NOTHING`,
  );
  const timestamp = nowIso();

  connection.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insert.run(key, JSON.stringify(value), timestamp);
    }
  })();
}
