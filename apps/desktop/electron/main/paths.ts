import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the app keeps things on disk.
 *
 * The database lives in userData, never next to the executable: an installer
 * update replaces the program directory wholesale and would take the shop's
 * data with it. Backups and receipts go under Documents instead, where the
 * owner can find, copy and email them without being told a hidden path.
 */

function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

/** `%APPDATA%/al-hamza-pos` — program-managed state. */
export function userDataDir(): string {
  return ensureDir(app.getPath('userData'));
}

/** The live SQLite database. */
export function databasePath(): string {
  return join(userDataDir(), 'pos.db');
}

/** `Documents/AlHamzaPOS` — everything the owner might want to open themselves. */
export function documentsDir(): string {
  return ensureDir(join(app.getPath('documents'), 'AlHamzaPOS'));
}

export function backupsDir(): string {
  return ensureDir(join(documentsDir(), 'backups'));
}

export function receiptsDir(): string {
  return ensureDir(join(documentsDir(), 'receipts'));
}

/** Where a saved report lands, so the owner can attach it to something. */
export function exportsDir(): string {
  return ensureDir(join(documentsDir(), 'reports'));
}

/** Item photos and the shop logo. Kept in userData so backups stay small. */
export function photosDir(): string {
  return ensureDir(join(userDataDir(), 'photos'));
}

export function logsDir(): string {
  return ensureDir(join(userDataDir(), 'logs'));
}
