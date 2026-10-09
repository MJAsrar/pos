import type BetterSqlite3 from 'better-sqlite3';
import { createReadStream, createWriteStream, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { AppError } from '../errors.js';
import { userDataDir } from '../paths.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabaseConfig.js';

/**
 * One copy of the database, kept somewhere that is not the shop.
 *
 * The local backups and the cloud tables each cover something this does not.
 * The local backups can restore the shop to a state it was actually in, but
 * they sit on the same disk, in the same shop, behind the same electricity. The
 * cloud tables survive the computer dying, but they are a replica — a mistake
 * made at the counter is copied up faithfully within the minute, so they cannot
 * undo anything.
 *
 * This is the third case: the file, offsite. One object per day, thirty days
 * kept.
 *
 * Deliberately never automatic in the other direction. Restoring is a decision
 * someone makes while looking at what they are about to overwrite, which is
 * what the Settings screen is for.
 */

const BUCKET = 'shop-backups';
const KEEP_DAYS = 30;

export interface OffsiteResult {
  object: string;
  bytes: number;
  removed: number;
}

/** `pos-2026-10-10.db.gz` — one per shop day, replaced if it runs twice. */
export function offsiteObjectName(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `pos-${year}-${month}-${day}.db.gz`;
}

/** The date in an object name, or null if it is not one of ours. */
export function dateFromObjectName(name: string): string | null {
  const match = /^pos-(\d{4}-\d{2}-\d{2})\.db\.gz$/.exec(name);
  return match?.[1] ?? null;
}

/** Which of these objects are older than the window worth keeping. */
export function expiredObjects(
  names: readonly string[],
  today: Date,
  keepDays = KEEP_DAYS,
): string[] {
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffDay = offsiteObjectName(cutoff).slice(4, 14);

  return names.filter((name) => {
    const day = dateFromObjectName(name);
    return day !== null && day < cutoffDay;
  });
}

export interface OffsiteDeps {
  db: BetterSqlite3.Database;
  accessToken: () => Promise<string>;
  /** Folder this terminal writes under, so two terminals never collide. */
  deviceId: string;
  now?: () => Date;
}

/**
 * Take a consistent snapshot, compress it, and put it in the bucket.
 *
 * `db.backup()` rather than copying the file: the app has the database open,
 * and a plain copy can catch a write half-finished. The integrity check comes
 * first, because uploading a corrupt file over a good one would turn a bad day
 * into a disaster.
 */
export async function uploadOffsiteBackup(deps: OffsiteDeps): Promise<OffsiteResult> {
  const now = deps.now?.() ?? new Date();
  const integrity = deps.db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new AppError(
      'database_corrupt',
      `The database reported a problem (${integrity}), so nothing was sent offsite.`,
    );
  }

  const snapshot = join(userDataDir(), 'offsite-snapshot.db');
  const compressed = `${snapshot}.gz`;

  try {
    await deps.db.backup(snapshot);
    await pipeline(createReadStream(snapshot), createGzip({ level: 9 }), createWriteStream(compressed));

    const bytes = statSync(compressed).size;
    const object = `${deps.deviceId}/${offsiteObjectName(now)}`;
    const token = await deps.accessToken();

    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${object}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/gzip',
        // Running twice in a day replaces the day's copy rather than failing.
        'x-upsert': 'true',
      },
      // Read into memory rather than streamed: the whole shop compresses to
      // well under a megabyte, and a stream body needs half-duplex handling
      // that buys nothing at this size.
      body: new Uint8Array(readFileSync(compressed)),
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Offsite backup was refused (${response.status}). ${detail.slice(0, 200)}`);
    }

    const removed = await pruneOffsite(deps, token, now);
    return { object, bytes, removed };
  } finally {
    // Both are rebuilt next time; leaving them would double the disk the app
    // uses on a machine that may not have much.
    rmSync(snapshot, { force: true });
    rmSync(compressed, { force: true });
  }
}

interface StorageObject {
  name: string;
}

async function pruneOffsite(deps: OffsiteDeps, token: string, now: Date): Promise<number> {
  const listed = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix: `${deps.deviceId}/`, limit: 200, sortBy: { column: 'name', order: 'asc' } }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!listed.ok) return 0;

  const objects = (await listed.json()) as StorageObject[];
  const stale = expiredObjects(objects.map((object) => object.name), now);
  if (!stale.length) return 0;

  const removed = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: stale.map((name) => `${deps.deviceId}/${name}`) }),
    signal: AbortSignal.timeout(30_000),
  });

  return removed.ok ? stale.length : 0;
}
