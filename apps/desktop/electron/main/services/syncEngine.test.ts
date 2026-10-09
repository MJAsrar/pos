import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowIso, uuidv7 } from '@pos/shared';
import { FakeSyncServer } from '../testing/fakeSyncServer.js';
import {
  adminActor,
  balanceOf,
  makeCustomer,
  makeItem,
  makeTestDb,
  makeUser,
  outbox,
  qtyOf,
} from '../testing/harness.js';
import { findItemById } from '../db/repos/itemRepo.js';
import { createSale } from './saleService.js';
import { saveItem } from './itemService.js';
import { runSync } from './syncEngine.js';
import { listConflicts, nextBatch, readState, syncStatus } from './syncService.js';

let db: BetterSqlite3.Database;
let userId: string;
let server: FakeSyncServer;

/** Clear the backlog the migration queues for rows that predate sync. */
async function settle(): Promise<void> {
  await runSync({ db, transport: server });
}

/** Change a price the way the Items screen does, so the trigger fires. */
function reprice(itemId: string, salePrice: number): void {
  const item = findItemById(db, itemId);
  if (!item) throw new Error('no such item');
  saveItem(
    db,
    {
      id: itemId,
      code: item.code,
      name: item.name,
      categoryId: item.categoryId,
      unit: item.unit,
      costPrice: item.costPrice,
      salePrice,
      minPrice: item.minPrice,
      lowStockLevel: item.lowStockLevel,
      photoPath: item.photoPath,
    },
    userId,
  );
}

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
  server = new FakeSyncServer();
});

afterEach(() => db.close());

describe('pushing what changed here', () => {
  it('sends a whole sale, and empties the queue', async () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, qty: 10 });
    await settle();

    createSale(
      db,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userId),
    );

    const result = await runSync({ db, transport: server });

    expect(result.problem).toBeNull();
    expect(server.count('sales')).toBe(1);
    expect(server.count('sale_items')).toBe(1);
    // The sale's movement, plus the item's opening stock.
    expect(server.count('stock_movements')).toBe(2);
    expect(outbox(db)).toHaveLength(0);
  });

  it('sends the bill before its lines', async () => {
    const itemId = makeItem(db, userId, { qty: 5 });
    await settle();

    createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 15000 },
      adminActor(userId),
    );
    await runSync({ db, transport: server });

    const order = server.tableOrder();
    expect(order.indexOf('sales')).toBeGreaterThan(-1);
    // Without this the foreign key fails on whichever device pulls it: the
    // outbox is ordered by table name, and `sale_items` sorts first.
    expect(order.indexOf('sales')).toBeLessThan(order.indexOf('sale_items'));
  });

  it('sends one copy of an item edited three times, carrying the latest price', async () => {
    const itemId = makeItem(db, userId, { salePrice: 10000 });
    await settle();

    for (const price of [20000, 30000, 44000]) {
      reprice(itemId, price);
    }

    expect(outbox(db, 'items')).toHaveLength(1);
    await runSync({ db, transport: server });

    expect(server.get('items', itemId)?.sale_price).toBe(44000);
  });

  it('never sends stock on hand, even though it is on the row', async () => {
    const itemId = makeItem(db, userId, { qty: 7 });
    await runSync({ db, transport: server });

    const sent = server.received
      .flatMap((request) => request.changes)
      .filter((change) => change.table === 'items');

    expect(sent).not.toHaveLength(0);
    for (const change of sent) expect(change.data).not.toHaveProperty('qty_on_hand');
    expect(server.get('items', itemId)).not.toHaveProperty('qty_on_hand');
  });

  it('sends a removed item as a row with a deletion date, not as an absence', async () => {
    const itemId = makeItem(db, userId, { qty: 0 });
    await settle();

    db.prepare(`UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(
      nowIso(),
      nowIso(),
      itemId,
    );
    await runSync({ db, transport: server });

    expect(server.get('items', itemId)?.deleted_at).toBeTruthy();
  });
});

describe('a change made while the server is answering', () => {
  it('stays queued, rather than being lost to the older acknowledgement', async () => {
    const itemId = makeItem(db, userId, { salePrice: 10000 });
    await settle();

    reprice(itemId, 20000);

    // The counter does not stop selling for a network call. This is the price
    // being changed again after the row was read and before the reply lands.
    server.onExchange = () => {
      server.onExchange = null;
      reprice(itemId, 35000);
    };

    await runSync({ db, transport: server });

    expect(outbox(db, 'items')).toHaveLength(1);
    expect(server.get('items', itemId)?.sale_price).toBe(20000);

    await runSync({ db, transport: server });

    expect(server.get('items', itemId)?.sale_price).toBe(35000);
    expect(outbox(db, 'items')).toHaveLength(0);
  });
});

describe('when the server cannot be reached', () => {
  it('keeps the queue intact and holds nothing against it', async () => {
    makeItem(db, userId);
    server.offline = true;

    const before = nextBatch(db).length;
    const result = await runSync({ db, transport: server });

    expect(result.reachedServer).toBe(false);
    expect(result.problem).toMatch(/internet/i);
    expect(nextBatch(db)).toHaveLength(before);
    // A week of bad internet must not fill the dead lane.
    expect(nextBatch(db).every((row) => row.attempts === 0)).toBe(true);
    expect(syncStatus(db, true).dead).toBe(0);
  });

  it('sends everything once the connection comes back', async () => {
    const itemId = makeItem(db, userId, { salePrice: 15000 });
    server.offline = true;
    await runSync({ db, transport: server });

    server.offline = false;
    const result = await runSync({ db, transport: server });

    expect(result.problem).toBeNull();
    expect(server.get('items', itemId)?.sale_price).toBe(15000);
    expect(outbox(db)).toHaveLength(0);
  });

  it('says plainly when it last managed to sync', async () => {
    makeItem(db, userId);
    await runSync({ db, transport: server });

    expect(readState(db, 'lastSyncedAt')).toBeTruthy();
    expect(readState(db, 'lastError')).toBeNull();
  });
});

describe('a row the server will not accept', () => {
  it('is set aside so the rows behind it still go', async () => {
    const good = makeItem(db, userId, { code: 'GOOD', salePrice: 11000 });
    const bad = makeItem(db, userId, { code: 'BAD', salePrice: 12000 });
    server.poisonRow = `items:${bad}`;

    const result = await runSync({ db, transport: server });

    expect(server.has('items', good)).toBe(true);
    expect(server.has('items', bad)).toBe(false);
    expect(result.problem).toBeNull();

    const stuck = nextBatch(db).find((row) => row.rowId === bad);
    expect(stuck?.attempts).toBe(1);
  });

  it('is marked for attention after it has failed enough times', async () => {
    const bad = makeItem(db, userId, { code: 'BAD' });
    server.poisonRow = `items:${bad}`;

    for (let attempt = 0; attempt < 10; attempt++) {
      await runSync({ db, transport: server });
    }

    const status = syncStatus(db, true);
    expect(status.dead).toBe(1);
    // And it is out of the way: nothing is left waiting behind it.
    expect(status.pending + status.failed).toBe(0);
  });

  it('does not count a rejection against the rest of the batch', async () => {
    const good = makeItem(db, userId, { code: 'GOOD' });
    await settle();

    // A table the server does not sync at all, queued by hand.
    db.prepare(
      `INSERT INTO sync_outbox (table_name, row_id, queued_at, attempts, status)
       VALUES ('held_sales', ?, ?, 0, 'pending')`,
    ).run(uuidv7(), nowIso());

    reprice(good, 9000);
    await runSync({ db, transport: server });

    expect(server.get('items', good)?.sale_price).toBe(9000);
    expect(nextBatch(db).map((row) => row.tableName)).toEqual(['held_sales']);
  });
});

describe('writing what changed there', () => {
  it('takes stock down for a sale made somewhere else', async () => {
    const itemId = makeItem(db, userId, { qty: 10 });
    await settle();

    // The owner sold three from the website: the movement is the truth, and
    // the quantity is never sent as an absolute figure.
    server.seed('stock_movements', uuidv7(), {
      id: uuidv7(),
      item_id: itemId,
      type: 'sale',
      qty_delta: -3,
      qty_after: 7,
      user_id: userId,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    await runSync({ db, transport: server });

    expect(qtyOf(db, itemId)).toBe(7);
  });

  it('moves a customer balance from a payment taken somewhere else', async () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 500000 });
    await settle();

    expect(balanceOf(db, customerId)).toBe(500000);

    server.seed('customer_ledger_entries', uuidv7(), {
      id: uuidv7(),
      customer_id: customerId,
      type: 'payment',
      amount: -200000,
      balance_after: 300000,
      user_id: userId,
      entry_date: nowIso(),
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    await runSync({ db, transport: server });

    expect(balanceOf(db, customerId)).toBe(300000);
  });

  it('ignores a stock figure even if the server sends one', async () => {
    const itemId = makeItem(db, userId, { qty: 4 });
    await settle();

    // Nothing should ever send this. If something does, it must not land.
    server.seed('items', itemId, {
      id: itemId,
      name: 'Renamed Elsewhere',
      qty_on_hand: 999,
      updated_at: nowIso(),
    });

    await runSync({ db, transport: server });

    const row = db.prepare(`SELECT name, qty_on_hand FROM items WHERE id = ?`).get(itemId) as {
      name: string;
      qty_on_hand: number;
    };
    expect(row.name).toBe('Renamed Elsewhere');
    expect(row.qty_on_hand).toBe(4);
  });

  it('does not send a pulled row straight back', async () => {
    await settle();
    const id = uuidv7();
    server.seed('categories', id, {
      id,
      name: 'Added On The Website',
      sort_order: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    await runSync({ db, transport: server });

    expect(outbox(db)).toHaveLength(0);
    const requestsSoFar = server.requests;
    await runSync({ db, transport: server });
    // One round trip to ask, nothing to tell.
    expect(server.requests).toBe(requestsSoFar + 1);
    expect(server.received.at(-1)?.changes).toHaveLength(0);
  });

  it('applies a bill and its lines even when they arrive out of order', async () => {
    const itemId = makeItem(db, userId, { qty: 5 });
    const customerId = makeCustomer(db, userId);
    await settle();

    const saleId = uuidv7();
    const lineId = uuidv7();

    // Seeded lines-first on purpose: the foreign key must be checked at the
    // end of the batch, not statement by statement.
    server.seed('sale_items', lineId, {
      id: lineId,
      sale_id: saleId,
      item_id: itemId,
      item_code: 'X1',
      item_name: 'Sold Elsewhere',
      unit: 'pcs',
      qty: 1,
      unit_price: 30000,
      cost_price: 20000,
      line_total: 30000,
      line_no: 1,
    });
    server.seed('sales', saleId, {
      id: saleId,
      invoice_no: 'WEB-1',
      customer_id: customerId,
      user_id: userId,
      sold_at: nowIso(),
      subtotal: 30000,
      discount: 0,
      rounding: 0,
      total: 30000,
      paid: 30000,
      payment_method: 'cash',
      cost_total: 20000,
      status: 'active',
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const result = await runSync({ db, transport: server });

    expect(result.problem).toBeNull();
    const line = db.prepare(`SELECT sale_id FROM sale_items WHERE id = ?`).get(lineId) as
      | { sale_id: string }
      | undefined;
    expect(line?.sale_id).toBe(saleId);
  });

  it('works through more than one page', async () => {
    await settle();
    for (let n = 0; n < 12; n++) {
      const id = uuidv7();
      server.seed('categories', id, {
        id,
        name: `Category ${n}`,
        sort_order: n,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    }
    server.pageSize = 5;

    const result = await runSync({ db, transport: server });

    expect(result.rounds).toBeGreaterThan(2);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM categories`).get() as { n: number };
    expect(count.n).toBeGreaterThanOrEqual(12);
  });

  it('asks only for what it has not seen', async () => {
    makeItem(db, userId);
    await runSync({ db, transport: server });
    const cursor = Number(readState(db, 'cursor'));
    expect(cursor).toBeGreaterThan(0);

    await runSync({ db, transport: server });

    expect(server.received.at(-1)?.cursor).toBe(cursor);
    expect(Number(readState(db, 'cursor'))).toBe(cursor);
  });
});

describe('when both sides changed the same thing', () => {
  it('keeps the other version, stops pushing ours, and leaves a note', async () => {
    const itemId = makeItem(db, userId, { salePrice: 60000 });
    await settle();

    // The owner repriced on the website a moment ago; the counter repriced an
    // hour earlier and is only now getting a connection.
    server.seed('items', itemId, {
      id: itemId,
      code: 'C1',
      name: 'Test Item',
      sale_price: 62000,
      updated_at: nowIso(),
    });
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    db.prepare(`UPDATE items SET sale_price = 60000, updated_at = ? WHERE id = ?`).run(
      anHourAgo,
      itemId,
    );

    const result = await runSync({ db, transport: server });

    expect(result.conflicts).toBe(1);

    const conflicts = listConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts.at(0)?.detail).toMatch(/changed somewhere else more recently/i);

    // The website's price is now the price here too, and ours is no longer
    // queued to overwrite it.
    const row = db.prepare(`SELECT sale_price FROM items WHERE id = ?`).get(itemId) as {
      sale_price: number;
    };
    expect(row.sale_price).toBe(62000);
    expect(outbox(db, 'items')).toHaveLength(0);
    expect(syncStatus(db, true).unseenConflicts).toBe(1);
  });

  it('leaves bills already rung at the old price alone', async () => {
    const itemId = makeItem(db, userId, { salePrice: 60000, qty: 10 });
    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 60000 },
      adminActor(userId),
    );
    await settle();

    server.seed('items', itemId, {
      id: itemId,
      code: 'C1',
      name: 'Test Item',
      sale_price: 99000,
      updated_at: nowIso(),
    });
    await runSync({ db, transport: server });

    const line = db
      .prepare(`SELECT unit_price FROM sale_items WHERE sale_id = ?`)
      .get(sale.id) as { unit_price: number };
    expect(line.unit_price).toBe(60000);
  });
});

describe('one at a time', () => {
  it('does nothing if a sync is already running', async () => {
    makeItem(db, userId);

    const [first, second] = await Promise.all([
      runSync({ db, transport: server }),
      runSync({ db, transport: server }),
    ]);

    expect([first.skipped, second.skipped].sort()).toEqual([false, true]);
    expect(outbox(db)).toHaveLength(0);
  });
});
