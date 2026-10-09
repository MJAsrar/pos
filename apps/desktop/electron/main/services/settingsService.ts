import type BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_SETTINGS, nowIso, type ShopSettings } from '@pos/shared';
import { writeAudit } from './auditService.js';

/**
 * Shop settings.
 *
 * Stored as JSON values in a key/value table rather than a single-row table, so
 * adding a setting never needs a migration on a live shop database. Reads always
 * merge over `DEFAULT_SETTINGS`, so a key that does not exist yet — or one whose
 * value got corrupted — falls back to something sane instead of `undefined`
 * reaching the receipt template.
 */

export function getSettings(db: BetterSqlite3.Database): ShopSettings {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as {
    key: string;
    value: string;
  }[];

  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // Leave the default in place for an unparseable value.
    }
  }

  const merged = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ShopSettings)[]) {
    const value = stored[key];
    if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
      (merged as Record<string, unknown>)[key] = value;
    } else if (key === 'logoPath' && (value === null || typeof value === 'string')) {
      merged.logoPath = value as string | null;
    }
  }
  return merged;
}

export function updateSettings(
  db: BetterSqlite3.Database,
  patch: Partial<ShopSettings>,
  actorId: string,
): ShopSettings {
  const before = getSettings(db);
  const statement = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const timestamp = nowIso();

  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      statement.run(key, JSON.stringify(value), timestamp);
    }
    writeAudit(db, {
      userId: actorId,
      action: 'settings.update',
      entity: 'settings',
      entityId: 'shop',
      summary: `Updated settings: ${Object.keys(patch).join(', ')}`,
      before,
      after: patch,
    });
  })();

  return getSettings(db);
}

/**
 * Take the next value from a counter.
 *
 * Must be called inside the transaction of whatever consumes the number, so a
 * rolled-back sale releases its invoice number instead of burning it.
 */
export function nextCounterValue(db: BetterSqlite3.Database, name: string): number {
  db.prepare(`UPDATE counters SET value = value + 1 WHERE name = ?`).run(name);
  const row = db.prepare(`SELECT value FROM counters WHERE name = ?`).get(name) as
    | { value: number }
    | undefined;
  if (!row) throw new Error(`Unknown counter: ${name}`);
  return row.value;
}
