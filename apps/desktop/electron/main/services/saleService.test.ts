import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  adminActor,
  balanceFromLedger,
  balanceOf,
  countMovements,
  countRows,
  makeCustomer,
  makeItem,
  makeTestDb,
  makeUser,
  qtyFromMovements,
  qtyOf,
} from '../testing/harness.js';
import { createSale, voidSale } from './saleService.js';

let db: BetterSqlite3.Database;
let userId: string;

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
});

afterEach(() => db.close());

describe('createSale', () => {
  it('records a cash sale and takes the stock down by exactly what was sold', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, costPrice: 18000, qty: 10 });

    const { sale, change } = createSale(
      db,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userId),
    );

    expect(sale.invoiceNo).toBe('AH-00001');
    expect(sale.total).toBe(50000);
    expect(sale.paid).toBe(50000);
    expect(sale.credit).toBe(0);
    expect(change).toBe(0);
    expect(qtyOf(db, itemId)).toBe(8);
    expect(qtyFromMovements(db, itemId)).toBe(8);
  });

  it('gives change without ever recording more than the total as paid', () => {
    const itemId = makeItem(db, userId, { salePrice: 18000, qty: 5 });

    const { sale, change } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 20000 },
      adminActor(userId),
    );

    expect(sale.paid).toBe(18000);
    expect(change).toBe(2000);
    expect(sale.credit).toBe(0);
  });

  it('snapshots the cost onto each line so later price changes cannot rewrite profit', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, costPrice: 18000, qty: 10 });

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 50000 },
      adminActor(userId),
    );

    db.prepare(`UPDATE items SET cost_price = 22000 WHERE id = ?`).run(itemId);

    const reread = db
      .prepare(`SELECT cost_price FROM sale_items WHERE sale_id = ?`)
      .get(sale.id) as { cost_price: number };

    expect(reread.cost_price).toBe(18000);
    expect(sale.costTotal).toBe(36000);
  });

  it('numbers bills in sequence', () => {
    const itemId = makeItem(db, userId, { qty: 100 });
    const actor = adminActor(userId);
    const numbers = [1, 2, 3].map(
      () =>
        createSale(db, { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 999999 }, actor)
          .sale.invoiceNo,
    );
    expect(numbers).toEqual(['AH-00001', 'AH-00002', 'AH-00003']);
  });

  it('rounds the bill to the rupee and records the adjustment', () => {
    const itemId = makeItem(db, userId, { salePrice: 3730, unit: 'mtr', qty: 100 });

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 2.5 }], paymentMethod: 'cash', tendered: 999999 },
      adminActor(userId),
    );

    expect(sale.subtotal).toBe(9325);
    expect(sale.total).toBe(9300);
    expect(sale.rounding).toBe(-25);
    expect(sale.subtotal - sale.discount + sale.rounding).toBe(sale.total);
  });
});

describe('createSale on credit', () => {
  it('puts a part payment shortfall onto the customer ledger', () => {
    const itemId = makeItem(db, userId, { salePrice: 200000, qty: 10 });
    const customerId = makeCustomer(db, userId);

    // Rs 2,000 bill, Rs 1,500 cash, Rs 500 on udhaar.
    const { sale, customerBalance } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'cash', tendered: 150000 },
      adminActor(userId),
    );

    expect(sale.paid).toBe(150000);
    expect(sale.credit).toBe(50000);
    expect(customerBalance).toBe(50000);
    expect(balanceOf(db, customerId)).toBe(50000);
    expect(balanceFromLedger(db, customerId)).toBe(50000);
  });

  it('adds to an existing balance rather than replacing it', () => {
    const itemId = makeItem(db, userId, { salePrice: 100000, qty: 10 });
    const customerId = makeCustomer(db, userId, { openingBalance: 300000 });
    const actor = adminActor(userId);

    createSale(db, { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' }, actor);
    createSale(db, { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' }, actor);

    expect(balanceOf(db, customerId)).toBe(500000);
    expect(balanceFromLedger(db, customerId)).toBe(500000);
  });

  it('links the ledger entry to the bill that caused it', () => {
    const itemId = makeItem(db, userId, { salePrice: 100000, qty: 10 });
    const customerId = makeCustomer(db, userId);

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' },
      adminActor(userId),
    );

    const entry = db
      .prepare(
        `SELECT type, amount, ref_type, ref_id, ref_label FROM customer_ledger_entries
          WHERE customer_id = ? AND type = 'credit_sale'`,
      )
      .get(customerId) as {
      type: string;
      amount: number;
      ref_type: string;
      ref_id: string;
      ref_label: string;
    };

    expect(entry).toMatchObject({
      type: 'credit_sale',
      amount: 100000,
      ref_type: 'sale',
      ref_id: sale.id,
      ref_label: sale.invoiceNo,
    });
  });

  it('refuses to leave a balance owing with no customer attached', () => {
    const itemId = makeItem(db, userId, { salePrice: 200000, qty: 10 });

    expect(() =>
      createSale(
        db,
        { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 150000 },
        adminActor(userId),
      ),
    ).toThrow(AppError);
  });
});

describe('createSale permissions', () => {
  it('refuses a price change from a cashier who may not make one', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, qty: 10 });

    expect(() =>
      createSale(
        db,
        { lines: [{ itemId, qty: 1, unitPrice: 20000 }], paymentMethod: 'cash', tendered: 20000 },
        { ...adminActor(userId), canEditPrice: false },
      ),
    ).toThrow(/not allowed to change prices/i);
  });

  it('allows the listed price to be passed explicitly without counting as a change', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, qty: 10 });

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1, unitPrice: 25000 }], paymentMethod: 'cash', tendered: 25000 },
      { ...adminActor(userId), canEditPrice: false },
    );
    expect(sale.total).toBe(25000);
  });

  it('refuses a discount and a credit sale from a cashier without those rights', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, qty: 10 });
    const customerId = makeCustomer(db, userId);

    expect(() =>
      createSale(
        db,
        { lines: [{ itemId, qty: 1 }], discount: 5000, paymentMethod: 'cash', tendered: 20000 },
        { ...adminActor(userId), canDiscount: false },
      ),
    ).toThrow(/not allowed to give discounts/i);

    expect(() =>
      createSale(
        db,
        { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' },
        { ...adminActor(userId), canSellOnCredit: false },
      ),
    ).toThrow(/udhaar/i);
  });

  it('blocks selling below the floor price, and records the override when allowed', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, minPrice: 20000, qty: 10 });

    expect(() =>
      createSale(
        db,
        { lines: [{ itemId, qty: 1, unitPrice: 15000 }], paymentMethod: 'cash', tendered: 15000 },
        { ...adminActor(userId), canEditPrice: false },
      ),
    ).toThrow(AppError);

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1, unitPrice: 15000 }], paymentMethod: 'cash', tendered: 15000 },
      adminActor(userId),
    );

    const override = db
      .prepare(`SELECT summary FROM audit_log WHERE action = 'sale.price_override'`)
      .get() as { summary: string } | undefined;

    expect(sale.total).toBe(15000);
    expect(override?.summary).toMatch(/Rs 150/);
  });
});

describe('createSale atomicity', () => {
  it('writes nothing at all when one line is invalid', () => {
    const good = makeItem(db, userId, { qty: 10 });

    expect(() =>
      createSale(
        db,
        {
          lines: [
            { itemId: good, qty: 1 },
            { itemId: 'does-not-exist', qty: 1 },
          ],
          paymentMethod: 'cash',
          tendered: 999999,
        },
        adminActor(userId),
      ),
    ).toThrow(AppError);

    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'sale_items')).toBe(0);
    expect(qtyOf(db, good)).toBe(10);
  });

  it('does not burn an invoice number on a failed sale', () => {
    const itemId = makeItem(db, userId, { qty: 10 });

    expect(() =>
      createSale(db, { lines: [{ itemId, qty: 0 }], paymentMethod: 'cash' }, adminActor(userId)),
    ).toThrow(AppError);

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 999999 },
      adminActor(userId),
    );
    expect(sale.invoiceNo).toBe('AH-00001');
  });

  it('rolls the whole transaction back when a write fails part-way through', () => {
    // A user id that is not in `users` passes every up-front check and then
    // trips the foreign key on the INSERT, which is the only way to fail after
    // the transaction has already taken an invoice number and is mid-write.
    const itemId = makeItem(db, userId, { qty: 10 });
    const ghost = { id: 'no-such-user', canEditPrice: true, canDiscount: true, canSellOnCredit: true };

    expect(() =>
      createSale(db, { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 999999 }, ghost),
    ).toThrow();

    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'sale_items')).toBe(0);
    // Stock untouched, and no orphan movement left behind for a sale that does not exist.
    expect(qtyOf(db, itemId)).toBe(10);
    expect(countMovements(db, 'sale')).toBe(0);

    // And the invoice number it had already claimed was released with it.
    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 999999 },
      adminActor(userId),
    );
    expect(sale.invoiceNo).toBe('AH-00001');
  });

  it('leaves the customer balance untouched when the sale fails', () => {
    const itemId = makeItem(db, userId, { qty: 10 });
    const customerId = makeCustomer(db, userId, { openingBalance: 100000 });

    expect(() =>
      createSale(
        db,
        { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' },
        { ...adminActor(userId), canSellOnCredit: false },
      ),
    ).toThrow(AppError);

    expect(balanceOf(db, customerId)).toBe(100000);
    expect(balanceFromLedger(db, customerId)).toBe(100000);
  });
});

describe('voidSale', () => {
  it('puts the stock back and reverses the udhaar', () => {
    const itemId = makeItem(db, userId, { salePrice: 100000, qty: 10 });
    const customerId = makeCustomer(db, userId);

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 3 }], customerId, paymentMethod: 'credit' },
      adminActor(userId),
    );

    expect(qtyOf(db, itemId)).toBe(7);
    expect(balanceOf(db, customerId)).toBe(300000);

    const voided = voidSale(db, sale.id, 'Rung up twice', userId);

    expect(voided.status).toBe('voided');
    expect(qtyOf(db, itemId)).toBe(10);
    expect(qtyFromMovements(db, itemId)).toBe(10);
    expect(balanceOf(db, customerId)).toBe(0);
    expect(balanceFromLedger(db, customerId)).toBe(0);
  });

  it('leaves the charge visible in the ledger rather than erasing it', () => {
    const itemId = makeItem(db, userId, { salePrice: 100000, qty: 10 });
    const customerId = makeCustomer(db, userId);

    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' },
      adminActor(userId),
    );
    voidSale(db, sale.id, 'Customer changed their mind', userId);

    const entries = db
      .prepare(
        `SELECT type, amount FROM customer_ledger_entries WHERE customer_id = ? ORDER BY created_at`,
      )
      .all(customerId) as Array<{ type: string; amount: number }>;

    expect(entries).toEqual([
      { type: 'credit_sale', amount: 100000 },
      { type: 'adjustment', amount: -100000 },
    ]);
  });

  it('insists on a reason and refuses to void twice', () => {
    const itemId = makeItem(db, userId, { qty: 10 });
    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 999999 },
      adminActor(userId),
    );

    expect(() => voidSale(db, sale.id, '   ', userId)).toThrow(/why/i);
    voidSale(db, sale.id, 'Mistake', userId);
    expect(() => voidSale(db, sale.id, 'Again', userId)).toThrow(/already cancelled/i);
  });
});
