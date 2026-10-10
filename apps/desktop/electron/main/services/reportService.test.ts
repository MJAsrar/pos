import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { today } from '@pos/shared';
import { adminActor, makeCustomer, makeItem, makeTestDb, makeUser } from '../testing/harness.js';
import { saveExpense } from './expenseService.js';
import { salesSummary } from './reportService.js';
import { createReturn } from './returnService.js';
import { createSale, voidSale } from './saleService.js';

/**
 * The daily figures, against real sales rather than hand-made rows.
 *
 * Written because these numbers are about to be computed in a second place —
 * the owner's phone, against Postgres instead of SQLite — and the two must
 * agree. Nothing guarded them before, so a change to either side could have
 * moved one and not the other with nobody noticing until the owner and the
 * cashier read different takings off the same day.
 */

let db: BetterSqlite3.Database;
let userId: string;

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
});

afterEach(() => db.close());

const todayRange = () => ({ from: today(), to: today() });

describe('salesSummary', () => {
  it('adds up a plain cash day', () => {
    const itemId = makeItem(db, userId, { salePrice: 50_000, costPrice: 30_000, qty: 10 });
    createSale(
      db,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 100_000 },
      adminActor(userId),
    );

    const summary = salesSummary(db, todayRange());
    expect(summary.billCount).toBe(1);
    expect(summary.netSales).toBe(100_000);
    expect(summary.costOfGoods).toBe(60_000);
    expect(summary.grossProfit).toBe(40_000);
    expect(summary.cashTaken).toBe(100_000);
    expect(summary.onCredit).toBe(0);
    expect(summary.netProfit).toBe(40_000);
  });

  it('counts what went on udhaar separately from what was handed over', () => {
    const itemId = makeItem(db, userId, { salePrice: 200_000, costPrice: 140_000, qty: 5 });
    const customerId = makeCustomer(db, userId);

    createSale(
      db,
      {
        lines: [{ itemId, qty: 1 }],
        paymentMethod: 'cash',
        customerId,
        tendered: 150_000,
      },
      adminActor(userId),
    );

    const summary = salesSummary(db, todayRange());
    // Sold is sold, whether or not it has been paid for.
    expect(summary.netSales).toBe(200_000);
    expect(summary.cashTaken).toBe(150_000);
    expect(summary.onCredit).toBe(50_000);
    expect(summary.grossProfit).toBe(60_000);
  });

  it('takes a return off the takings and its cost off the cost', () => {
    const itemId = makeItem(db, userId, { salePrice: 50_000, costPrice: 30_000, qty: 10 });
    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 100_000 },
      adminActor(userId),
    );
    const line = db.prepare(`SELECT id FROM sale_items WHERE sale_id = ?`).get(sale.id) as {
      id: string;
    };

    createReturn(
      db,
      { saleId: sale.id, lines: [{ saleItemId: line.id, qty: 1 }], refundMethod: 'cash' },
      userId,
    );

    const summary = salesSummary(db, todayRange());
    expect(summary.returns).toBe(50_000);
    expect(summary.netSales).toBe(50_000);
    expect(summary.costOfGoods).toBe(30_000);
    // The margin on what the customer kept, not a loss.
    expect(summary.grossProfit).toBe(20_000);
  });

  it('leaves a cancelled bill out of everything', () => {
    const itemId = makeItem(db, userId, { salePrice: 50_000, costPrice: 30_000, qty: 10 });
    const { sale } = createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50_000 },
      adminActor(userId),
    );
    voidSale(db, sale.id, 'rung up twice', userId);

    const summary = salesSummary(db, todayRange());
    expect(summary.billCount).toBe(0);
    expect(summary.netSales).toBe(0);
    expect(summary.grossProfit).toBe(0);
  });

  it('takes what was spent off what was left over', () => {
    const itemId = makeItem(db, userId, { salePrice: 50_000, costPrice: 30_000, qty: 10 });
    createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50_000 },
      adminActor(userId),
    );
    saveExpense(db, { category: 'Shop rent', amount: 15_000, spentAt: today() }, userId);

    const summary = salesSummary(db, todayRange());
    expect(summary.grossProfit).toBe(20_000);
    expect(summary.expenses).toBe(15_000);
    expect(summary.netProfit).toBe(5_000);
  });

  it('can report a loss, rather than flooring at zero', () => {
    const itemId = makeItem(db, userId, { salePrice: 50_000, costPrice: 30_000, qty: 10 });
    createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50_000 },
      adminActor(userId),
    );
    saveExpense(db, { category: 'Repairs', amount: 60_000, spentAt: today() }, userId);

    expect(salesSummary(db, todayRange()).netProfit).toBe(-40_000);
  });

  it('reports a day with nothing in it as zeroes', () => {
    const summary = salesSummary(db, todayRange());
    expect(summary.billCount).toBe(0);
    expect(summary.netSales).toBe(0);
    expect(summary.grossProfit).toBe(0);
    expect(summary.netProfit).toBe(0);
    expect(summary.byDay).toEqual([]);
  });

  it('keeps the per-day rows agreeing with the totals', () => {
    const itemId = makeItem(db, userId, { salePrice: 50_000, costPrice: 30_000, qty: 10 });
    createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50_000 },
      adminActor(userId),
    );
    createSale(
      db,
      { lines: [{ itemId, qty: 1 }], paymentMethod: 'cash', tendered: 50_000 },
      adminActor(userId),
    );

    const summary = salesSummary(db, todayRange());
    const fromDays = summary.byDay.reduce((sum, row) => sum + row.netSales, 0);
    expect(fromDays).toBe(summary.netSales);
    expect(summary.byDay.reduce((sum, row) => sum + row.billCount, 0)).toBe(summary.billCount);
  });
});
