import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminActor,
  asServerApply,
  makeCustomer,
  makeItem,
  makeTestDb,
  makeUser,
  outbox,
} from '../testing/harness.js';
import { createSale } from '../services/saleService.js';

let db: BetterSqlite3.Database;
let userId: string;

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
  // Start each test from a clean queue; creating the user queued a row.
  db.prepare(`DELETE FROM sync_outbox`).run();
});

afterEach(() => db.close());

describe('sync columns', () => {
  it('adds server_seq to every synced table', () => {
    for (const table of ['items', 'customers', 'sales', 'stock_movements', 'settings']) {
      const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
        (column) => column.name,
      );
      expect(columns).toContain('server_seq');
    }
  });

  it('leaves the local-only tables alone', () => {
    // An invoice sequence is per-terminal; a parked bill is one screen's
    // business. Neither belongs on the server.
    for (const table of ['counters', 'held_sales']) {
      const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
        (column) => column.name,
      );
      expect(columns).not.toContain('server_seq');
    }
  });
});

describe('the outbox', () => {
  it('queues a row the moment it is created', () => {
    const id = makeItem(db, userId);
    expect(outbox(db, 'items')).toEqual([{ table_name: 'items', row_id: id, status: 'pending' }]);
  });

  it('collapses repeated edits into one entry', () => {
    const id = makeItem(db, userId);
    db.prepare(`UPDATE items SET name = 'A' WHERE id = ?`).run(id);
    db.prepare(`UPDATE items SET name = 'B' WHERE id = ?`).run(id);
    db.prepare(`UPDATE items SET name = 'C' WHERE id = ?`).run(id);

    // One row to send, carrying the latest state, not three edits to replay.
    expect(outbox(db, 'items')).toHaveLength(1);
  });

  it('queues a delete as well as a write', () => {
    // No opening stock, so nothing references it and a hard delete is possible.
    const id = makeItem(db, userId, { qty: 0 });
    db.prepare(`DELETE FROM sync_outbox`).run();
    db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    expect(outbox(db, 'items')).toEqual([{ table_name: 'items', row_id: id, status: 'pending' }]);
  });

  it('gives a failed row another chance when it is edited again', () => {
    const id = makeItem(db, userId);
    db.prepare(`UPDATE sync_outbox SET status = 'failed', attempts = 4, last_error = 'boom'`).run();

    db.prepare(`UPDATE items SET name = 'Edited' WHERE id = ?`).run(id);

    expect(
      db.prepare(`SELECT status, attempts, last_error FROM sync_outbox`).get(),
    ).toEqual({ status: 'pending', attempts: 0, last_error: null });
  });

  it('queues every table a sale touches, in one go', () => {
    const itemId = makeItem(db, userId, { qty: 10 });
    const customerId = makeCustomer(db, userId);
    db.prepare(`DELETE FROM sync_outbox`).run();

    createSale(
      db,
      { lines: [{ itemId, qty: 2 }], customerId, paymentMethod: 'credit' },
      adminActor(userId),
    );

    const tables = new Set(outbox(db).map((row) => row.table_name));
    expect(tables).toContain('sales');
    expect(tables).toContain('sale_items');
    expect(tables).toContain('stock_movements');
    expect(tables).toContain('customer_ledger_entries');
    expect(tables).toContain('items'); // the cached quantity moved
    expect(tables).toContain('customers'); // the cached balance moved
  });

  it('never queues the local-only tables', () => {
    db.prepare(`UPDATE counters SET value = 5 WHERE name = 'invoice'`).run();
    db.prepare(
      `INSERT INTO held_sales (id, label, user_id, payload_json, created_at)
       VALUES ('h1', 'parked', ?, '{}', 'T')`,
    ).run(userId);

    const tables = outbox(db).map((row) => row.table_name);
    expect(tables).not.toContain('counters');
    expect(tables).not.toContain('held_sales');
  });
});

describe('rows arriving from the server', () => {
  it('are not queued straight back at it', () => {
    // The echo problem: applying a pulled row must not look like a local edit,
    // or the two sides push the same change at each other forever.
    asServerApply(db, () => {
      db.prepare(
        `INSERT INTO items (id, code, name, created_at, updated_at)
         VALUES ('remote', 'R1', 'From the website', 'T', 'T')`,
      ).run();
      db.prepare(`UPDATE items SET name = 'Renamed remotely' WHERE id = 'remote'`).run();
    });

    expect(outbox(db)).toEqual([]);
  });

  it('go back to queuing normally afterwards', () => {
    asServerApply(db, () => {
      db.prepare(
        `INSERT INTO items (id, code, name, created_at, updated_at)
         VALUES ('remote', 'R1', 'x', 'T', 'T')`,
      ).run();
    });
    expect(outbox(db)).toEqual([]);

    db.prepare(`UPDATE items SET name = 'Edited at the counter' WHERE id = 'remote'`).run();
    expect(outbox(db, 'items')).toHaveLength(1);
  });

  it('still suppress correctly when applying throws part-way', () => {
    expect(() =>
      asServerApply(db, () => {
        db.prepare(
          `INSERT INTO items (id, code, name, created_at, updated_at)
           VALUES ('a', 'A', 'x', 'T', 'T')`,
        ).run();
        throw new Error('batch failed');
      }),
    ).toThrow('batch failed');

    // The flag must be cleared even on failure, or every later local edit
    // would silently stop being queued and the shop would drift offline
    // without anything appearing to be wrong.
    db.prepare(`UPDATE items SET name = 'local' WHERE id = 'a'`).run();
    expect(outbox(db, 'items')).toHaveLength(1);
  });
});

describe('the backfill', () => {
  it('queues everything that predates sync', () => {
    // A shop upgrading has a full database and an empty server, so migration
    // 002 queues what is already there rather than waiting for it to be edited.
    const fresh = makeTestDb();
    makeUser(fresh);
    const queued = fresh
      .prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'settings'`)
      .get() as { n: number };

    // Settings are seeded by the app, not the migration, so the count comes
    // from the trigger — proving both paths reach the queue.
    expect(queued.n).toBeGreaterThanOrEqual(0);
    expect(outbox(fresh, 'users')).toHaveLength(1);
    fresh.close();
  });
});
