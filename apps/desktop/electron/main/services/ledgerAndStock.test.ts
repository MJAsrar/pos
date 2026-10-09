import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  adminActor,
  balanceFromLedger,
  balanceOf,
  makeCustomer,
  makeItem,
  makeTestDb,
  makeUser,
  qtyFromMovements,
  qtyOf,
} from '../testing/harness.js';
import {
  adjustBalance,
  createCustomer,
  customerLedger,
  findLedgerMismatches,
  receivePayment,
  removeCustomer,
} from './customerService.js';
import {
  adjustStock,
  applyStockCount,
  findStockMismatches,
  itemHistory,
  repairStockCache,
  stockIn,
} from './stockService.js';
import { createSale } from './saleService.js';

let db: BetterSqlite3.Database;
let userId: string;

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
});

afterEach(() => db.close());

describe('customer ledger', () => {
  it('opens an account with the balance carried over from the register', () => {
    const customer = createCustomer(
      db,
      { name: 'Ali Traders', phone: '0300 1234567', address: null, notes: null, openingBalance: 840000 },
      userId,
    );

    expect(customer.balance).toBe(840000);
    const ledger = customerLedger(db, customer.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'opening', amount: 840000, balanceAfter: 840000 });
  });

  it('records an advance as a negative opening balance', () => {
    const customer = createCustomer(
      db,
      { name: 'Paid Ahead', phone: null, address: null, notes: null, openingBalance: -50000 },
      userId,
    );
    expect(customer.balance).toBe(-50000);
  });

  it('reduces the balance when a payment comes in', () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 300000 });

    const { balanceAfter } = receivePayment(
      db,
      { customerId, amount: 200000, method: 'cash', note: 'Part payment' },
      userId,
    );

    expect(balanceAfter).toBe(100000);
    expect(balanceOf(db, customerId)).toBe(100000);
    expect(balanceFromLedger(db, customerId)).toBe(100000);
  });

  it('reconciles a full khata line by line', () => {
    const itemId = makeItem(db, userId, { salePrice: 125000, qty: 100 });
    const customerId = makeCustomer(db, userId, { openingBalance: 300000 });
    const actor = adminActor(userId);

    createSale(db, { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' }, actor);
    receivePayment(db, { customerId, amount: 200000, method: 'cash' }, userId);
    createSale(db, { lines: [{ itemId, qty: 1 }], customerId, paymentMethod: 'credit' }, actor);

    // 3000 + 1250 - 2000 + 1250 = Rs 3,500
    expect(balanceOf(db, customerId)).toBe(350000);

    const ledger = customerLedger(db, customerId);
    let running = 0;
    for (const entry of ledger) {
      running += entry.amount;
      // Every stored running balance agrees with the sum of everything before it.
      expect(entry.balanceAfter).toBe(running);
    }
    expect(running).toBe(350000);
    expect(findLedgerMismatches(db)).toEqual([]);
  });

  it('rejects a payment of zero or less', () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 100000 });
    for (const amount of [0, -500]) {
      expect(() => receivePayment(db, { customerId, amount, method: 'cash' }, userId)).toThrow(AppError);
    }
    expect(balanceOf(db, customerId)).toBe(100000);
  });

  it('requires a reason for a manual adjustment', () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 100000 });
    expect(() => adjustBalance(db, customerId, -5000, '  ', userId)).toThrow(/why/i);
    adjustBalance(db, customerId, -5000, 'Rounded off at the customer request', userId);
    expect(balanceOf(db, customerId)).toBe(95000);
  });

  it('refuses to remove a customer who still owes money', () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 100000 });
    expect(() => removeCustomer(db, customerId, userId)).toThrow(/still has a balance/i);
  });

  it('deactivates rather than deletes a customer with history', () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 100000 });
    receivePayment(db, { customerId, amount: 100000, method: 'cash' }, userId);

    const { deleted } = removeCustomer(db, customerId, userId);
    expect(deleted).toBe(false);
    // Their ledger survives, because it is the evidence behind settled debts.
    expect(customerLedger(db, customerId).length).toBeGreaterThan(0);
  });

  it('spots a balance that was tampered with outside a transaction', () => {
    const customerId = makeCustomer(db, userId, { openingBalance: 100000 });
    db.prepare(`UPDATE customers SET balance = 999999 WHERE id = ?`).run(customerId);

    const mismatches = findLedgerMismatches(db);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ cached: 999999, fromEntries: 100000 });
  });
});

describe('stock movements', () => {
  it('raises stock and updates the cost price on stock-in', () => {
    const itemId = makeItem(db, userId, { costPrice: 15000, qty: 5 });

    const { qtyAfter, costPrice } = stockIn(
      db,
      { itemId, qty: 20, unitCost: 16000, supplierName: 'Lahore Traders' },
      userId,
    );

    expect(qtyAfter).toBe(25);
    expect(costPrice).toBe(16000);
    expect(qtyOf(db, itemId)).toBe(25);
    expect(qtyFromMovements(db, itemId)).toBe(25);
  });

  it('keeps the old cost when no new cost is given', () => {
    const itemId = makeItem(db, userId, { costPrice: 15000, qty: 5 });
    const { costPrice } = stockIn(db, { itemId, qty: 10 }, userId);
    expect(costPrice).toBe(15000);
  });

  it('stores an adjustment as a delta, derived from the counted quantity', () => {
    const itemId = makeItem(db, userId, { qty: 10 });

    const { qtyAfter, qtyDelta } = adjustStock(
      db,
      { itemId, countedQty: 7, reason: 'damaged' },
      userId,
    );

    expect(qtyAfter).toBe(7);
    expect(qtyDelta).toBe(-3);

    const history = itemHistory(db, itemId);
    expect(history[0]).toMatchObject({ type: 'adjustment', qtyDelta: -3, qtyAfter: 7, reason: 'damaged' });
  });

  it('refuses an adjustment that changes nothing', () => {
    const itemId = makeItem(db, userId, { qty: 10 });
    expect(() => adjustStock(db, { itemId, countedQty: 10, reason: 'correction' }, userId)).toThrow(
      /already the recorded quantity/i,
    );
  });

  it('explains every movement of an item, newest first', () => {
    const itemId = makeItem(db, userId, { salePrice: 25000, qty: 10 });
    stockIn(db, { itemId, qty: 5, supplierName: 'Lahore Traders' }, userId);
    createSale(
      db,
      { lines: [{ itemId, qty: 2 }], paymentMethod: 'cash', tendered: 999999 },
      adminActor(userId),
    );

    const history = itemHistory(db, itemId);
    expect(history.map((row) => row.type)).toEqual(['sale', 'stock_in', 'opening']);
    // The running quantity is recorded on each movement, so the stock level at
    // any past moment can be read straight off the history.
    expect(history.map((row) => row.qtyAfter)).toEqual([13, 15, 10]);
    expect(history[0]?.refLabel).toBe('AH-00001');
  });

  it('handles fractional quantities for goods sold by the metre', () => {
    const itemId = makeItem(db, userId, { unit: 'mtr', salePrice: 10000, qty: 100 });
    const actor = adminActor(userId);

    createSale(db, { lines: [{ itemId, qty: 2.5 }], paymentMethod: 'cash', tendered: 999999 }, actor);
    createSale(db, { lines: [{ itemId, qty: 0.75 }], paymentMethod: 'cash', tendered: 999999 }, actor);

    expect(qtyOf(db, itemId)).toBe(96.75);
    expect(qtyFromMovements(db, itemId)).toBe(96.75);
  });

  it('spots and repairs a stock figure that drifted from its history', () => {
    const itemId = makeItem(db, userId, { qty: 10 });
    db.prepare(`UPDATE items SET qty_on_hand = 999 WHERE id = ?`).run(itemId);

    const mismatches = findStockMismatches(db);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ cached: 999, fromMovements: 10 });

    expect(repairStockCache(db, userId)).toBe(1);
    expect(qtyOf(db, itemId)).toBe(10);
    expect(findStockMismatches(db)).toEqual([]);
  });
});

describe('applyStockCount', () => {
  it('corrects several items in one go', () => {
    const a = makeItem(db, userId, { qty: 10 });
    const b = makeItem(db, userId, { qty: 5 });

    const result = applyStockCount(
      db,
      [
        { itemId: a, countedQty: 7 },
        { itemId: b, countedQty: 9 },
      ],
      userId,
    );

    expect(result).toEqual({ adjusted: 2, unchanged: 0, netChange: 1 });
    expect(qtyOf(db, a)).toBe(7);
    expect(qtyOf(db, b)).toBe(9);
    expect(qtyFromMovements(db, a)).toBe(7);
  });

  it('writes a movement only for what actually changed', () => {
    const a = makeItem(db, userId, { qty: 10 });
    const b = makeItem(db, userId, { qty: 5 });

    const result = applyStockCount(
      db,
      [
        { itemId: a, countedQty: 10 }, // counted, and it matched
        { itemId: b, countedQty: 3 },
      ],
      userId,
    );

    expect(result).toMatchObject({ adjusted: 1, unchanged: 1 });
    expect(itemHistory(db, a).filter((m) => m.type === 'adjustment')).toHaveLength(0);
    expect(itemHistory(db, b).filter((m) => m.type === 'adjustment')).toHaveLength(1);
  });

  it('records a count of zero as a real correction', () => {
    // Counting zero is a finding. It must not be confused with not counting.
    const id = makeItem(db, userId, { qty: 8 });
    expect(applyStockCount(db, [{ itemId: id, countedQty: 0 }], userId).adjusted).toBe(1);
    expect(qtyOf(db, id)).toBe(0);
  });

  it('leaves everything alone when one entry is bad', () => {
    const a = makeItem(db, userId, { qty: 10 });
    const b = makeItem(db, userId, { qty: 5 });

    expect(() =>
      applyStockCount(
        db,
        [
          { itemId: a, countedQty: 7 },
          { itemId: b, countedQty: -1 },
        ],
        userId,
      ),
    ).toThrow(AppError);

    expect(qtyOf(db, a)).toBe(10);
    expect(qtyOf(db, b)).toBe(5);
  });

  it('refuses an item that no longer exists, changing nothing', () => {
    const id = makeItem(db, userId, { qty: 10 });
    expect(() =>
      applyStockCount(
        db,
        [
          { itemId: id, countedQty: 4 },
          { itemId: 'ghost', countedQty: 1 },
        ],
        userId,
      ),
    ).toThrow(AppError);
    expect(qtyOf(db, id)).toBe(10);
  });

  it('handles fractional counts for goods sold by length', () => {
    const id = makeItem(db, userId, { unit: 'mtr', qty: 100 });
    applyStockCount(db, [{ itemId: id, countedQty: 87.5 }], userId);
    expect(qtyOf(db, id)).toBe(87.5);
    expect(qtyFromMovements(db, id)).toBe(87.5);
  });

  it('records the count in the audit log', () => {
    const id = makeItem(db, userId, { qty: 10 });
    applyStockCount(db, [{ itemId: id, countedQty: 4 }], userId);

    const entry = db
      .prepare(`SELECT summary FROM audit_log WHERE action = 'stock.count'`)
      .get() as { summary: string } | undefined;
    expect(entry?.summary).toMatch(/1 item corrected/);
  });

  it('refuses an empty count', () => {
    expect(() => applyStockCount(db, [], userId)).toThrow(/no counts/i);
  });

  it('leaves the stock figures reconciling with their history', () => {
    const ids = [1, 2, 3].map(() => makeItem(db, userId, { qty: 20 }));
    applyStockCount(db, ids.map((id, i) => ({ itemId: id, countedQty: 10 + i })), userId);
    expect(findStockMismatches(db)).toEqual([]);
  });
});
