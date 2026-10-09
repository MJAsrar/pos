import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7, type Unit } from '@pos/shared';
import { migrations } from '../db/migrations/index.js';
import { createCustomer } from '../services/customerService.js';
import { createItem } from '../services/itemService.js';
import type { SaleActor } from '../services/saleService.js';

/**
 * An in-memory shop, for tests.
 *
 * Runs the real migrations and the real services rather than hand-written
 * fixtures, so a test exercises the same code path the counter does.
 */
export function makeTestDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of migrations) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  return db;
}

export function makeUser(
  db: BetterSqlite3.Database,
  options: { role?: 'admin' | 'staff'; name?: string } = {},
): string {
  const id = uuidv7();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, full_name, pin_hash, role, permissions_json, created_at, updated_at)
     VALUES (?, ?, ?, 'test-hash', ?, '[]', ?, ?)`,
  ).run(
    id,
    `user-${id.slice(0, 8)}`,
    options.name ?? 'Test User',
    options.role ?? 'admin',
    timestamp,
    timestamp,
  );
  return id;
}

/** An actor allowed to do everything, so tests opt out rather than opt in. */
export function adminActor(id: string): SaleActor {
  return { id, canEditPrice: true, canDiscount: true, canSellOnCredit: true };
}

export interface TestItemOptions {
  code?: string;
  name?: string;
  costPrice?: number;
  salePrice?: number;
  minPrice?: number | null;
  unit?: Unit;
  qty?: number;
}

export function makeItem(
  db: BetterSqlite3.Database,
  userId: string,
  options: TestItemOptions = {},
): string {
  const item = createItem(
    db,
    {
      code: options.code ?? `C${Math.floor(Math.random() * 1_000_000)}`,
      name: options.name ?? 'Test Item',
      categoryId: null,
      unit: options.unit ?? 'pcs',
      costPrice: options.costPrice ?? 10000,
      salePrice: options.salePrice ?? 15000,
      minPrice: options.minPrice ?? null,
      lowStockLevel: 0,
      photoPath: null,
      openingQty: options.qty ?? 100,
    },
    userId,
  );
  return item.id;
}

export function makeCustomer(
  db: BetterSqlite3.Database,
  userId: string,
  options: { name?: string; openingBalance?: number } = {},
): string {
  const customer = createCustomer(
    db,
    {
      name: options.name ?? 'Test Customer',
      phone: null,
      address: null,
      notes: null,
      openingBalance: options.openingBalance ?? 0,
    },
    userId,
  );
  return customer.id;
}

/** Current stock for an item, read from the cache. */
export function qtyOf(db: BetterSqlite3.Database, itemId: string): number {
  const row = db.prepare(`SELECT qty_on_hand FROM items WHERE id = ?`).get(itemId) as {
    qty_on_hand: number;
  };
  return row.qty_on_hand;
}

/** Stock recomputed from movements, to check the cache against its source. */
export function qtyFromMovements(db: BetterSqlite3.Database, itemId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(qty_delta), 0) AS total FROM stock_movements WHERE item_id = ?`)
    .get(itemId) as { total: number };
  return Math.round(row.total * 1000) / 1000;
}

export function balanceOf(db: BetterSqlite3.Database, customerId: string): number {
  const row = db.prepare(`SELECT balance FROM customers WHERE id = ?`).get(customerId) as {
    balance: number;
  };
  return row.balance;
}

export function balanceFromLedger(db: BetterSqlite3.Database, customerId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM customer_ledger_entries
        WHERE customer_id = ? AND deleted_at IS NULL`,
    )
    .get(customerId) as { total: number };
  return row.total;
}

export function countRows(db: BetterSqlite3.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

/** Movements of one kind, for checking nothing was orphaned by a rollback. */
export function countMovements(db: BetterSqlite3.Database, type: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM stock_movements WHERE type = ?`)
    .get(type) as { count: number };
  return row.count;
}

/** What is currently queued for the server. */
export function outbox(
  db: BetterSqlite3.Database,
  table?: string,
): Array<{ table_name: string; row_id: string; status: string }> {
  const where = table ? ` WHERE table_name = '${table}'` : '';
  return db
    .prepare(`SELECT table_name, row_id, status FROM sync_outbox${where} ORDER BY queued_at, row_id`)
    .all() as Array<{ table_name: string; row_id: string; status: string }>;
}

/**
 * Run something as though it were a batch arriving from the server.
 *
 * Mirrors what the sync engine does, including clearing the flag when the work
 * throws — a flag left set would silently stop queuing every later local edit.
 */
export function asServerApply<T>(db: BetterSqlite3.Database, work: () => T): T {
  db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('applying', '1')`).run();
  try {
    return work();
  } finally {
    db.prepare(`DELETE FROM sync_state WHERE key = 'applying'`).run();
  }
}
