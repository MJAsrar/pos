import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@pos/shared';
import { AppError } from '../errors.js';
import { backupsDir, databasePath } from '../paths.js';
import { writeAudit } from './auditService.js';

/**
 * Backups.
 *
 * For a single shop with no IT support this matters more than sync does. The
 * failure that actually happens is not a clever one — it is a dead hard disk, or
 * somebody deciding to "clean up" a folder. So backups go to Documents where the
 * owner can see and copy them, run automatically, and are verified before being
 * kept.
 */

const KEEP_DAILY = 14;
const KEEP_WEEKLY = 4;

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Copy the database to the backups folder.
 *
 * Uses SQLite's own online backup, which produces a consistent file even while
 * the app has the database open, rather than a plain file copy that can catch a
 * write half-finished.
 */
export async function createBackup(
  db: BetterSqlite3.Database,
  reason: 'manual' | 'startup' | 'shutdown',
  userId?: string,
): Promise<BackupFile> {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new AppError(
      'database_corrupt',
      `The database reported a problem (${integrity}). The last good backup has been kept. ` +
        `Do not keep using this computer for sales until someone has looked at it.`,
    );
  }

  const { name, path } = uniqueBackupPath(reason);

  await db.backup(path);
  prune();

  if (userId) {
    writeAudit(db, {
      userId,
      action: 'backup.create',
      entity: 'backup',
      entityId: name,
      summary: `Backup saved to ${name}`,
    });
  }

  const stats = statSync(path);
  return { name, path, sizeBytes: stats.size, createdAt: nowIso() };
}

export function listBackups(): BackupFile[] {
  const dir = backupsDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const path = join(dir, name);
      const stats = statSync(path);
      return {
        name,
        path,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Keep the last 14 days plus one per week for a month.
 *
 * A fault noticed on Monday often started the previous week, so keeping only
 * recent backups means the only copies are the ones already carrying the problem.
 */
function prune(): void {
  const files = listBackups();
  if (files.length <= KEEP_DAILY) return;

  const keep = new Set(files.slice(0, KEEP_DAILY).map((file) => file.name));
  const weeksSeen = new Set<string>();

  for (const file of files.slice(KEEP_DAILY)) {
    const week = isoWeek(new Date(file.createdAt));
    if (weeksSeen.size < KEEP_WEEKLY && !weeksSeen.has(week)) {
      weeksSeen.add(week);
      keep.add(file.name);
    }
  }

  for (const file of files) {
    if (!keep.has(file.name)) {
      try {
        unlinkSync(file.path);
      } catch {
        // A file that is locked or already gone is not worth failing a backup over.
      }
    }
  }
}

/**
 * Restore the shop database from a backup file.
 *
 * The current database is moved aside rather than overwritten, so a restore from
 * the wrong file is itself recoverable. The app must be restarted afterwards:
 * the open connection still points at the replaced file.
 */
/**
 * Check a backup really is a shop database before anything is destroyed.
 *
 * Restoring from a truncated or corrupt file over a working database would be
 * the worst outcome this app can produce, so the file is opened and proved
 * first — while the live database is still untouched.
 */
export function inspectBackup(backupPath: string): { schemaVersion: number; sales: number } {
  if (!existsSync(backupPath)) {
    throw new AppError('not_found', 'That backup file is no longer there.');
  }

  let probe: BetterSqlite3.Database | null = null;
  try {
    probe = new Database(backupPath, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new AppError('backup_corrupt', `That backup is damaged (${integrity}) and was not used.`);
    }
    const version = probe.pragma('user_version', { simple: true }) as number;
    if (!version) {
      throw new AppError('backup_invalid', 'That file is not an Al Hamza POS backup.');
    }
    const sales = probe.prepare(`SELECT COUNT(*) AS n FROM sales`).get() as { n: number };
    return { schemaVersion: version, sales: sales.n };
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError(
      'backup_invalid',
      `That file could not be read as a database, so nothing was changed. ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    probe?.close();
  }
}

/**
 * Put a backup back in place of the live database.
 *
 * The connection MUST already be closed when this runs. SQLite holds the file
 * open, and Windows will not rename a file that is open — so the caller closes
 * the database first and relaunches the app afterwards. The old `-wal` and
 * `-shm` files are deleted with it: a write-ahead log left over from the
 * replaced database would be applied on top of the restored one.
 */
export function restoreBackup(backupPath: string): { replacedTo: string } {
  const live = databasePath();
  const replaced = uniqueBackupPath('replaced').path;

  try {
    if (existsSync(live)) renameSync(live, replaced);
  } catch (cause) {
    throw new AppError(
      'restore_failed',
      `The current database could not be moved aside, so nothing was changed. ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  for (const sidecar of [`${live}-wal`, `${live}-shm`]) {
    try {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    } catch {
      // Best effort. A leftover sidecar beside a replaced main file is only a
      // problem if it survives, and SQLite rebuilds both on next open.
    }
  }

  try {
    copyFileSync(backupPath, live);
  } catch (cause) {
    // Put things back exactly as they were rather than leaving no database.
    if (existsSync(replaced)) renameSync(replaced, live);
    throw new AppError(
      'restore_failed',
      `The backup could not be copied into place, so the original database was kept. ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return { replacedTo: replaced };
}

/**
 * A backup filename that cannot collide with one already on disk.
 *
 * Stamping only to the second meant two backups taken in the same second wrote
 * to the same name, and the second silently destroyed the first — including,
 * once, the very file a restore was about to read from. Milliseconds make that
 * vanishingly unlikely; the counter makes it impossible.
 */
export function nextBackupName(
  reason: string,
  now: Date,
  taken: (name: string) => boolean,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 23);

  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? `pos-${stamp}-${reason}.db` : `pos-${stamp}-${reason}-${attempt}.db`;
    if (!taken(name)) return name;
  }
}

function uniqueBackupPath(reason: string): { name: string; path: string } {
  const dir = backupsDir();
  const name = nextBackupName(reason, new Date(), (candidate) => existsSync(join(dir, candidate)));
  return { name, path: join(dir, name) };
}

function isoWeek(date: Date): string {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${week}`;
}
