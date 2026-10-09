import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestVersion, migrations } from './migrations/index.js';

let db: Database.Database;

function applyAll(target: Database.Database): void {
  for (const migration of migrations) {
    target.exec(migration.sql);
    target.pragma(`user_version = ${migration.version}`);
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAll(db);
});

afterEach(() => db.close());

function tableNames(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('schema', () => {
  it('creates every table the app needs', () => {
    expect(tableNames().sort()).toEqual(
      [
        'audit_log',
        'categories',
        'counters',
        'customer_ledger_entries',
        'customer_payments',
        'customers',
        'expenses',
        'held_sales',
        'items',
        'sale_items',
        'sale_return_items',
        'sale_returns',
        'sales',
        'settings',
        'stock_movements',
        'users',
      ].sort(),
    );
  });

  it('records the schema version so migrations are not replayed', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(latestVersion);
  });

  it('seeds the invoice and return counters at zero', () => {
    const rows = db.prepare(`SELECT name, value FROM counters ORDER BY name`).all();
    expect(rows).toEqual([
      { name: 'invoice', value: 0 },
      { name: 'return', value: 0 },
    ]);
  });
});

describe('constraints', () => {
  const user = () =>
    db
      .prepare(
        `INSERT INTO users (id, username, full_name, pin_hash, role, created_at, updated_at)
         VALUES ('u1', 'owner', 'Owner', 'hash', 'admin', 'T', 'T')`,
      )
      .run();

  it('rejects an unknown role', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, username, full_name, pin_hash, role, created_at, updated_at)
           VALUES ('u2', 'x', 'X', 'h', 'manager', 'T', 'T')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects a duplicate item code while both items exist', () => {
    const insert = db.prepare(
      `INSERT INTO items (id, code, name, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')`,
    );
    insert.run('i1', '101', 'Cable');
    expect(() => insert.run('i2', '101', 'Other cable')).toThrow(/UNIQUE/i);
  });

  it('frees an item code once the item is soft-deleted', () => {
    const insert = db.prepare(
      `INSERT INTO items (id, code, name, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')`,
    );
    insert.run('i1', '101', 'Cable');
    db.prepare(`UPDATE items SET deleted_at = 'T' WHERE id = 'i1'`).run();
    expect(() => insert.run('i2', '101', 'Replacement cable')).not.toThrow();
  });

  it('rejects a sale referencing a user that does not exist', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO sales (id, invoice_no, user_id, sold_at, subtotal, total, payment_method, created_at, updated_at)
           VALUES ('s1', 'AH-00001', 'ghost', 'T', 100, 100, 'cash', 'T', 'T')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('rejects an unknown payment method', () => {
    user();
    expect(() =>
      db
        .prepare(
          `INSERT INTO sales (id, invoice_no, user_id, sold_at, subtotal, total, payment_method, created_at, updated_at)
           VALUES ('s1', 'AH-00001', 'u1', 'T', 100, 100, 'barter', 'T', 'T')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects a duplicate invoice number outright', () => {
    user();
    const insert = db.prepare(
      `INSERT INTO sales (id, invoice_no, user_id, sold_at, subtotal, total, payment_method, created_at, updated_at)
       VALUES (?, ?, 'u1', 'T', 100, 100, 'cash', 'T', 'T')`,
    );
    insert.run('s1', 'AH-00001');
    expect(() => insert.run('s2', 'AH-00001')).toThrow(/UNIQUE/i);
  });

  it('deletes a bill and its lines together', () => {
    user();
    db.prepare(
      `INSERT INTO items (id, code, name, created_at, updated_at) VALUES ('i1', '101', 'Cable', 'T', 'T')`,
    ).run();
    db.prepare(
      `INSERT INTO sales (id, invoice_no, user_id, sold_at, subtotal, total, payment_method, created_at, updated_at)
       VALUES ('s1', 'AH-00001', 'u1', 'T', 100, 100, 'cash', 'T', 'T')`,
    ).run();
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, item_id, item_code, item_name, qty, unit_price, cost_price, line_total, line_no)
       VALUES ('l1', 's1', 'i1', '101', 'Cable', 1, 100, 60, 100, 1)`,
    ).run();

    db.prepare(`DELETE FROM sales WHERE id = 's1'`).run();
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM sale_items`).get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('rejects an unknown stock movement type', () => {
    user();
    db.prepare(
      `INSERT INTO items (id, code, name, created_at, updated_at) VALUES ('i1', '101', 'Cable', 'T', 'T')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO stock_movements (id, item_id, type, qty_delta, qty_after, user_id, created_at, updated_at)
           VALUES ('m1', 'i1', 'teleport', 1, 1, 'u1', 'T', 'T')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
  });

  it('stores signed ledger amounts in either direction', () => {
    user();
    db.prepare(
      `INSERT INTO customers (id, name, created_at, updated_at) VALUES ('c1', 'Ali', 'T', 'T')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO customer_ledger_entries (id, customer_id, type, amount, balance_after, user_id, entry_date, created_at, updated_at)
       VALUES (?, 'c1', ?, ?, ?, 'u1', 'T', 'T', 'T')`,
    );
    insert.run('e1', 'credit_sale', 50000, 50000);
    insert.run('e2', 'payment', -20000, 30000);

    const total = db
      .prepare(`SELECT SUM(amount) AS balance FROM customer_ledger_entries WHERE customer_id = 'c1'`)
      .get() as { balance: number };
    expect(total.balance).toBe(30000);
  });
});
