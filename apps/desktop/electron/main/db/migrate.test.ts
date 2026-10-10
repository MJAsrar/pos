import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowIso, uuidv7 } from '@pos/shared';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';

/**
 * The copy taken before a schema change is the shop's only way back if a
 * migration is wrong, and for a while it was a 4 KB file with no tables in it.
 *
 * In WAL mode recent writes sit in a `-wal` file beside the database and the
 * main file can be nearly empty, so copying the one file caught nothing. The
 * bug was invisible precisely because nobody opens a safety net until the day
 * it is needed — so these tests open it.
 */

let workspace: string;
let dbPath: string;
let backupDir: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pos-migrate-'));
  dbPath = join(workspace, 'pos.db');
  backupDir = join(workspace, 'backups');
  mkdirSync(backupDir, { recursive: true });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** A shop sitting at the schema version before sync was added. */
function shopAtVersion1(): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const first = migrations.find((m) => m.version === 1);
  if (!first) throw new Error('migration 1 is missing');
  db.exec(first.sql);
  db.pragma('user_version = 1');

  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, full_name, pin_hash, role, permissions_json, created_at, updated_at)
     VALUES (?, 'hamza', 'Muhammad Hamza', 'hash', 'admin', '[]', ?, ?)`,
  ).run(uuidv7(), timestamp, timestamp);

  db.prepare(
    `INSERT INTO items (id, code, name, unit, cost_price, sale_price, qty_on_hand, low_stock_level, created_at, updated_at)
     VALUES (?, '101', 'Capillary tube 0.31', 'pcs', 3200, 5000, 6, 0, ?, ?)`,
  ).run(uuidv7(), timestamp, timestamp);

  return db;
}

describe('the copy taken before a schema change', () => {
  it('holds the shop that was there, not an empty file', () => {
    const db = shopAtVersion1();
    // Deliberately not checkpointed: this is the state a shop is actually in,
    // with the day's writes still in the write-ahead log.
    const result = migrate(db, dbPath, { backupDir });
    db.close();

    expect(result.from).toBe(1);
    expect(result.backupPath).toBeTruthy();

    const saved = new Database(result.backupPath as string, { readonly: true, fileMustExist: true });
    expect(saved.pragma('user_version', { simple: true })).toBe(1);
    expect(saved.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 1 });

    const item = saved.prepare(`SELECT code, name, sale_price FROM items`).get();
    expect(item).toEqual({ code: '101', name: 'Capillary tube 0.31', sale_price: 5000 });
    saved.close();
  });

  it('passes an integrity check, so it can actually be restored', () => {
    const db = shopAtVersion1();
    const result = migrate(db, dbPath, { backupDir });
    db.close();

    const saved = new Database(result.backupPath as string, { readonly: true });
    expect(saved.pragma('integrity_check', { simple: true })).toBe('ok');
    saved.close();
  });

  it('is not taken for a database that has nothing in it yet', () => {
    // A fresh install goes straight from nothing to the current version.
    // A file named like a restore point but holding nothing is a trap.
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const result = migrate(db, dbPath, { backupDir });
    db.close();

    expect(result.from).toBe(0);
    expect(result.backupPath).toBeNull();
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it('leaves the live database working afterwards', () => {
    // The checkpoint truncates the log; the connection must carry on normally.
    const db = shopAtVersion1();
    migrate(db, dbPath, { backupDir });

    expect(db.pragma('user_version', { simple: true })).toBe(
      migrations[migrations.length - 1]?.version,
    );
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO items (id, code, name, unit, cost_price, sale_price, qty_on_hand, low_stock_level, created_at, updated_at)
       VALUES (?, '102', 'Capillary tube 0.36', 'pcs', 3200, 5000, 0, 0, ?, ?)`,
    ).run(uuidv7(), timestamp, timestamp);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM items`).get()).toEqual({ n: 2 });
    db.close();
  });
});
