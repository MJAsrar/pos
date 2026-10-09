import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  adminActor,
  balanceFromLedger,
  balanceOf,
  countRows,
  makeCustomer,
  makeItem,
  makeTestDb,
  makeUser,
  qtyFromMovements,
  qtyOf,
} from '../testing/harness.js';
import { createSale } from './saleService.js';
import { createReturn, listReturnsForSale } from './returnService.js';
import { findSaleById } from '../db/repos/saleRepo.js';

let db: BetterSqlite3.Database;
let userId: string;

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
});

afterEach(() => db.close());

/** A three-of-one-item cash bill, the starting point for most of these. */
function sell(qty = 3, salePrice = 25000, customerId?: string) {
  const itemId = makeItem(db, userId, { salePrice, costPrice: 18000, qty: 10 });
  const { sale } = createSale(
    db,
    {
      lines: [{ itemId, qty }],
      customerId: customerId ?? null,
      paymentMethod: customerId ? 'credit' : 'cash',
      tendered: customerId ? 0 : 999999,
    },
    adminActor(userId),
  );
  return { itemId, sale };
}

describe('createReturn', () => {
  it('puts the returned stock back and refunds in cash', () => {
    const { itemId, sale } = sell(3);
    expect(qtyOf(db, itemId)).toBe(7);

    const { refundAmount } = createReturn(
      db,
      {
        saleId: sale.id,
        lines: [{ saleItemId: sale.lines[0]!.id, qty: 1 }],
        refundMethod: 'cash',
      },
      userId,
    );

    expect(refundAmount).toBe(25000);
    expect(qtyOf(db, itemId)).toBe(8);
    expect(qtyFromMovements(db, itemId)).toBe(8);
  });

  it('numbers returns separately from bills', () => {
    const { sale } = sell(3);
    const result = createReturn(
      db,
      { saleId: sale.id, lines: [{ saleItemId: sale.lines[0]!.id, qty: 1 }], refundMethod: 'cash' },
      userId,
    );
    expect(result.returnRecord.returnNo).toBe('AHR-00001');
    expect(sale.invoiceNo).toBe('AH-00001');
  });

  it('refunds at the price actually charged, not the current list price', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, qty: 10 });
    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 2, unitPrice: 20000 }], paymentMethod: 'cash', tendered: 999999 },
      adminActor(userId),
    );

    db.prepare(`UPDATE items SET sale_price = 40000 WHERE id = ?`).run(itemId);

    const { refundAmount } = createReturn(
      db,
      { saleId: sale.id, lines: [{ saleItemId: sale.lines[0]!.id, qty: 1 }], refundMethod: 'cash' },
      userId,
    );

    expect(refundAmount).toBe(20000);
  });

  it('credits a customer account instead of handing over cash', () => {
    const customerId = makeCustomer(db, userId);
    const { sale } = sell(2, 100000, customerId);
    expect(balanceOf(db, customerId)).toBe(200000);

    const { customerBalance } = createReturn(
      db,
      {
        saleId: sale.id,
        lines: [{ saleItemId: sale.lines[0]!.id, qty: 1 }],
        refundMethod: 'credit_note',
      },
      userId,
    );

    expect(customerBalance).toBe(100000);
    expect(balanceOf(db, customerId)).toBe(100000);
    expect(balanceFromLedger(db, customerId)).toBe(100000);
  });

  it('refuses to credit an account when the bill had no customer', () => {
    const { sale } = sell(3);
    expect(() =>
      createReturn(
        db,
        {
          saleId: sale.id,
          lines: [{ saleItemId: sale.lines[0]!.id, qty: 1 }],
          refundMethod: 'credit_note',
        },
        userId,
      ),
    ).toThrow(/no customer/i);
  });
});

describe('createReturn limits', () => {
  it('refuses more than was sold', () => {
    const { sale } = sell(3);
    expect(() =>
      createReturn(
        db,
        { saleId: sale.id, lines: [{ saleItemId: sale.lines[0]!.id, qty: 5 }], refundMethod: 'cash' },
        userId,
      ),
    ).toThrow(/only 3/i);
  });

  it('counts earlier returns against what is still returnable', () => {
    const { itemId, sale } = sell(3);
    const lineId = sale.lines[0]!.id;

    createReturn(db, { saleId: sale.id, lines: [{ saleItemId: lineId, qty: 2 }], refundMethod: 'cash' }, userId);

    // One left.
    expect(() =>
      createReturn(db, { saleId: sale.id, lines: [{ saleItemId: lineId, qty: 2 }], refundMethod: 'cash' }, userId),
    ).toThrow(/only 1/i);

    createReturn(db, { saleId: sale.id, lines: [{ saleItemId: lineId, qty: 1 }], refundMethod: 'cash' }, userId);

    expect(() =>
      createReturn(db, { saleId: sale.id, lines: [{ saleItemId: lineId, qty: 1 }], refundMethod: 'cash' }, userId),
    ).toThrow(/already been returned in full/i);

    expect(qtyOf(db, itemId)).toBe(10);
  });

  it('reports how much of each line is still returnable', () => {
    const { sale } = sell(3);
    createReturn(
      db,
      { saleId: sale.id, lines: [{ saleItemId: sale.lines[0]!.id, qty: 1 }], refundMethod: 'cash' },
      userId,
    );

    const reread = findSaleById(db, sale.id);
    expect(reread?.lines[0]?.returnedQty).toBe(1);
    expect(reread?.returnedTotal).toBe(25000);
  });

  it('rejects a zero or negative quantity', () => {
    const { sale } = sell(3);
    for (const qty of [0, -1]) {
      expect(() =>
        createReturn(
          db,
          { saleId: sale.id, lines: [{ saleItemId: sale.lines[0]!.id, qty }], refundMethod: 'cash' },
          userId,
        ),
      ).toThrow(AppError);
    }
  });

  it('rejects a line that belongs to a different bill', () => {
    const first = sell(3);
    const second = sell(3);
    expect(() =>
      createReturn(
        db,
        {
          saleId: first.sale.id,
          lines: [{ saleItemId: second.sale.lines[0]!.id, qty: 1 }],
          refundMethod: 'cash',
        },
        userId,
      ),
    ).toThrow(/not on this bill/i);
  });

  it('writes nothing when any line in the return is invalid', () => {
    const { itemId, sale } = sell(3);

    expect(() =>
      createReturn(
        db,
        {
          saleId: sale.id,
          lines: [
            { saleItemId: sale.lines[0]!.id, qty: 1 },
            { saleItemId: 'nope', qty: 1 },
          ],
          refundMethod: 'cash',
        },
        userId,
      ),
    ).toThrow(AppError);

    expect(countRows(db, 'sale_returns')).toBe(0);
    expect(countRows(db, 'sale_return_items')).toBe(0);
    expect(qtyOf(db, itemId)).toBe(7);
  });
});

describe('listReturnsForSale', () => {
  it('lists every return raised against a bill', () => {
    const { sale } = sell(3);
    const lineId = sale.lines[0]!.id;
    createReturn(db, { saleId: sale.id, lines: [{ saleItemId: lineId, qty: 1 }], refundMethod: 'cash' }, userId);
    createReturn(db, { saleId: sale.id, lines: [{ saleItemId: lineId, qty: 1 }], refundMethod: 'cash' }, userId);

    const returns = listReturnsForSale(db, sale.id);
    expect(returns).toHaveLength(2);
    expect(returns.map((entry) => entry.returnNo).sort()).toEqual(['AHR-00001', 'AHR-00002']);
    expect(returns[0]?.lines[0]?.itemName).toBeTruthy();
  });
});
