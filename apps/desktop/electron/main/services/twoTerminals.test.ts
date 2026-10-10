import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSyncServer } from '../testing/fakeSyncServer.js';
import { adminActor, makeItem, makeTestDb, makeUser } from '../testing/harness.js';
import { createSale } from './saleService.js';
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
