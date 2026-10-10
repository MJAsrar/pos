import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSyncServer } from '../testing/fakeSyncServer.js';
import { adminActor, makeItem, makeTestDb, makeUser } from '../testing/harness.js';
import { nowIso } from '@pos/shared';
import { createSale } from './saleService.js';
import { createReturn } from './returnService.js';
import { getSettings } from './settingsService.js';
import { runSync } from './syncEngine.js';


/**
 * What happens when the shop runs a second till.
 *
 * Not the shape the shop is in today — one PC at the counter — but the one the
 * data model was supposed to tolerate without a rewrite, and the one that
 * arrives the day the owner buys another computer. Both terminals talk to the
 * same cloud database; neither talks to the other.
 */

let counter: BetterSqlite3.Database;
let backRoom: BetterSqlite3.Database;
let server: FakeSyncServer;

beforeEach(() => {
  counter = makeTestDb();
  backRoom = makeTestDb();
  server = new FakeSyncServer();
});

afterEach(() => {
  counter.close();
  backRoom.close();
});

/** Push and pull until both sides have stopped having anything to say. */
async function syncBoth(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await runSync({ db: counter, transport: server });
    await runSync({ db: backRoom, transport: server });
  }
}

describe('a second till', () => {
  it('starts from the catalogue the first one already has', async () => {
    const user = makeUser(counter);
    makeItem(counter, user, { code: 'C1', name: 'Compressor 1/4 HP', salePrice: 1650000, qty: 4 });
    await runSync({ db: counter, transport: server });

    // The second machine starts empty and is told nothing but how to sign in.
    await runSync({ db: backRoom, transport: server });

    const item = backRoom.prepare(`SELECT name, sale_price, qty_on_hand FROM items`).get() as {
      name: string;
      sale_price: number;
      qty_on_hand: number;
    };
    expect(item.name).toBe('Compressor 1/4 HP');
    expect(item.sale_price).toBe(1650000);
    // Stock arrived as its movements and was added back up here.
    expect(item.qty_on_hand).toBe(4);
  });

  it('takes stock down for what the other one sold', async () => {
    const user = makeUser(counter);
    const itemId = makeItem(counter, user, { code: 'C1', salePrice: 50000, qty: 10 });
    await syncBoth();

    createSale(
      counter,
      { lines: [{ itemId, qty: 3 }], paymentMethod: 'cash', tendered: 150000 },
      adminActor(user),
    );
    await syncBoth();

    const here = backRoom.prepare(`SELECT qty_on_hand FROM items WHERE id = ?`).get(itemId) as {
      qty_on_hand: number;
    };
    expect(here.qty_on_hand).toBe(7);
  });

  /**
   * Known broken, and recorded here rather than described in a comment.
   *
   * The invoice sequence is per-machine on purpose: it has to keep working
   * with no connection, so it cannot ask the server for the next number. But
   * the number carries nothing to say which machine minted it, so both tills
   * reach for AH-00001 — and the unique index on `sales.invoice_no` refuses
   * the second one the moment it arrives from the other side.
   *
   * The plan called for a device component in the number from day one. It was
   * not built. Until it is, a shop must run one till at a time.
   */
  it('today breaks sync when two tills both number a bill AH-00001', async () => {
    const userA = makeUser(counter);
    const itemA = makeItem(counter, userA, { code: 'C1', salePrice: 50000, qty: 10 });
    await syncBoth();

    const userB = backRoom.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string };

    const first = createSale(
      counter,
      { lines: [{ itemId: itemA, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userA),
    );
    const second = createSale(
      backRoom,
      { lines: [{ itemId: itemA, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userB.id),
    );

    // Two different bills, same number.
    expect(first.sale.invoiceNo).toBe('AH-00001');
    expect(second.sale.invoiceNo).toBe('AH-00001');
    expect(first.sale.id).not.toBe(second.sale.id);

    await expect(syncBoth()).rejects.toThrow(/UNIQUE constraint failed: sales.invoice_no/);
  });

  /**
   * And it does not recover on its own, which is the part that makes it
   * serious rather than untidy. The page cannot be applied, so the cursor
   * cannot advance, so every later sale queues behind a row that will never
   * go in — while the status line blames the internet.
   */
  it('and stays broken for every sale after it', async () => {
    const userA = makeUser(counter);
    const itemA = makeItem(counter, userA, { code: 'C1', salePrice: 50000, qty: 10 });
    await syncBoth();
    const userB = backRoom.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string };

    createSale(
      counter,
      { lines: [{ itemId: itemA, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userA),
    );
    createSale(
      backRoom,
      { lines: [{ itemId: itemA, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userB.id),
    );
    await expect(syncBoth()).rejects.toThrow();

    // A later, perfectly ordinary sale. It reaches the server, because pushing
    // still works — but this till can no longer read anything back.
    createSale(
      counter,
      { lines: [{ itemId: itemA, qty: 2 }], paymentMethod: 'cash', tendered: 100000 },
      adminActor(userA),
    );
    await expect(runSync({ db: counter, transport: server })).rejects.toThrow();
  });
});

describe('a replacement till, taking over from the old one', () => {
  it('carries on the bill numbers instead of claiming one already used', async () => {
    // The shop buys a new computer and the old one is retired. One till at a
    // time, so none of the two-till trouble applies — and it still used to
    // break, for a reason that is easy to miss: `counters` is deliberately
    // never synced, so the new machine started its sequence at zero while
    // already holding the bills it had pulled down.
    const old = makeUser(counter);
    const itemId = makeItem(counter, old, { code: 'C1', salePrice: 50000, qty: 10 });
    for (let bill = 0; bill < 3; bill++) {
      createSale(
        counter,
        { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
        adminActor(old),
      );
    }
    await runSync({ db: counter, transport: server });

    // The new machine pulls everything, including AH-00001 to AH-00003.
    await runSync({ db: backRoom, transport: server });
    const pulled = backRoom.prepare(`SELECT invoice_no FROM sales ORDER BY invoice_no`).all() as Array<{
      invoice_no: string;
    }>;
    expect(pulled.map((row) => row.invoice_no)).toEqual(['AH-00001', 'AH-00002', 'AH-00003']);

    const user = backRoom.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string };
    const next = createSale(
      backRoom,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(user.id),
    );

    expect(next.sale.invoiceNo).toBe('AH-00004');
  });

  it('carries on the return numbers too, which run their own series', async () => {
    const old = makeUser(counter);
    const itemId = makeItem(counter, old, { code: 'C1', salePrice: 50000, qty: 10 });
    const sale = createSale(
      counter,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 100000 },
      adminActor(old),
    );
    const line = counter.prepare(`SELECT id FROM sale_items WHERE sale_id = ?`).get(sale.sale.id) as {
      id: string;
    };
    const taken = createReturn(
      counter,
      { saleId: sale.sale.id, lines: [{ saleItemId: line.id, qty: 1 }], refundMethod: 'cash' },
      old,
    );
    expect(taken.returnRecord.returnNo).toBe('AHR-00001');

    await runSync({ db: counter, transport: server });
    await runSync({ db: backRoom, transport: server });

    const user = backRoom.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string };
    const theirLine = backRoom
      .prepare(`SELECT id FROM sale_items WHERE sale_id = ?`)
      .get(sale.sale.id) as { id: string };

    const second = createReturn(
      backRoom,
      { saleId: sale.sale.id, lines: [{ saleItemId: theirLine.id, qty: 1 }], refundMethod: 'cash' },
      user.id,
    );
    expect(second.returnRecord.returnNo).toBe('AHR-00002');
  });

  it('starts a renamed series at one, with nothing to collide with', async () => {
    // The counter is a single sequence and the prefix is only how it is
    // shown, so renaming does not reset the numbers. But a machine joining
    // *after* a rename holds bills from the old series, and those must not
    // pull the new series along: there is nothing for it to collide with, and
    // skipping to 00006 would look like five missing bills.
    const old = makeUser(counter);
    const itemId = makeItem(counter, old, { code: 'C1', salePrice: 50000, qty: 10 });
    for (let bill = 0; bill < 5; bill++) {
      createSale(
        counter,
        { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
        adminActor(old),
      );
    }
    counter
      .prepare(
        // Settings values are stored JSON-encoded, the same as the app writes
        // them; a bare string would be ignored and the default used.
        `INSERT INTO settings (key, value, updated_at) VALUES ('invoicePrefix', ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify('HAMZA'), nowIso());
    await runSync({ db: counter, transport: server });

    await runSync({ db: backRoom, transport: server });
    expect(getSettings(backRoom).invoicePrefix).toBe('HAMZA');

    const user = backRoom.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string };
    const next = createSale(
      backRoom,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(user.id),
    );

    expect(next.sale.invoiceNo).toBe('HAMZA-00001');
  });
});
