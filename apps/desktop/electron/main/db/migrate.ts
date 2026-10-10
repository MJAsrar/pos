import type BetterSqlite3 from 'better-sqlite3';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupsDir } from '../paths.js';
import { latestVersion, migrations } from './migrations/index.js';

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
  backupPath: string | null;
}

/**
 * Bring the database up to the latest schema version.
 *
 * Each migration runs inside its own transaction, so a failure leaves the
 * database at the last version that fully succeeded rather than half-migrated.
 * Before the first pending migration is applied, the current file is copied
 * aside — if a migration is wrong, the shop's data is still recoverable.
 */
export function migrate(
  db: BetterSqlite3.Database,
  dbPath: string,
  options: { backupDir?: string } = {},
): MigrationResult {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current > latestVersion) {
    throw new Error(
      `Database schema is version ${current}, but this app only understands up to ` +
        `${latestVersion}. A newer version of Al Hamza POS has already opened this ` +
        `database — install the latest version rather than downgrading.`,
    );
  }

  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    return { from: current, to: current, applied: [], backupPath: null };
  }

  const backupPath =
    current > 0 ? backupBeforeMigration(db, dbPath, current, options.backupDir) : null;
  const applied: string[] = [];

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.sql);
      // pragma values cannot be bound as parameters
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      run();
      applied.push(`${migration.version}_${migration.name}`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${detail}` +
          (backupPath ? `\nThe database before this upgrade was backed up to:\n${backupPath}` : ''),
      );
    }
  }

  return { from: current, to: latestVersion, applied, backupPath };
}

/**
 * Copy the database aside before touching its schema.
 *
 * The checkpoint is the whole point of this function and was missing. In WAL
 * mode recent writes live in a `-wal` file beside the database, and the main
 * file can be almost empty — so a plain copy produced a 4 KB file with no
 * tables in it, which is what this safety net turned out to be when one was
 * finally opened. Folding the log in first makes the single copied file
 * complete, the same reason `createBackup` uses SQLite's own backup rather
 * than copying bytes.
 *
 * If the log cannot be folded in, nothing is migrated. A safety net that
 * might be empty is worse than refusing to start, because the shop would only
 * find out after a migration had already gone wrong.
 */
function backupBeforeMigration(
  db: BetterSqlite3.Database,
  dbPath: string,
  fromVersion: number,
  backupDir?: string,
): string {
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  if (checkpoint && checkpoint.busy !== 0) {
    throw new Error(
      'The database could not be copied aside before upgrading it, because something ' +
        'else is still writing to it. Close any other copy of Al Hamza POS and try again.',
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(backupDir ?? backupsDir(), `pos-${stamp}-before-v${fromVersion + 1}.db`);
  copyFileSync(dbPath, target);
  return target;
}
