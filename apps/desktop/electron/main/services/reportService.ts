import type BetterSqlite3 from 'better-sqlite3';
import {
  rangeToTimestamps,
  summarisePeriod,
  type DateRange,
  type PaymentMethod,
} from '@pos/shared';
import { expensesByCategory, expensesTotal } from './expenseService.js';

/**
 * Reports.
 *
 * Two rules run through all of them. Cancelled bills are excluded everywhere,
 * and returns are subtracted from both revenue and cost — otherwise a day where
 * everything came back still reads as a good day. Cost always comes from the
 * snapshot on each sale line, never from the item's cost today, so last month's
 * profit does not move when a supplier raises their price.
 */

export interface SalesSummary {
  billCount: number;
  itemCount: number;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  costOfGoods: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  cashTaken: number;
  onCredit: number;
  byMethod: Array<{ method: PaymentMethod; billCount: number; total: number; paid: number }>;
  byDay: Array<{ date: string; billCount: number; netSales: number; grossProfit: number }>;
  byUser: Array<{ userId: string; userName: string; billCount: number; netSales: number }>;
  expenseBreakdown: Array<{ category: string; total: number }>;
}

export function salesSummary(db: BetterSqlite3.Database, range: DateRange): SalesSummary {
  const { start, end } = rangeToTimestamps(range);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS bill_count,
              COALESCE(SUM(subtotal), 0) AS gross,
              COALESCE(SUM(discount), 0) AS discounts,
              COALESCE(SUM(total), 0) AS net,
              COALESCE(SUM(cost_total), 0) AS cost,
              COALESCE(SUM(paid), 0) AS paid,
              COALESCE(SUM(total - paid), 0) AS credit
         FROM sales
        WHERE deleted_at IS NULL AND status = 'active' AND sold_at >= ? AND sold_at < ?`,
    )
    .get(start, end) as {
    bill_count: number;
    gross: number;
    discounts: number;
    net: number;
    cost: number;
    paid: number;
    credit: number;
  };

  const returned = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(cost_total), 0) AS cost
         FROM sale_returns
        WHERE deleted_at IS NULL AND returned_at >= ? AND returned_at < ?`,
    )
    .get(start, end) as { total: number; cost: number };

  const items = db
    .prepare(
      `SELECT COALESCE(SUM(li.qty), 0) AS qty
         FROM sale_items li
         JOIN sales s ON s.id = li.sale_id
        WHERE s.deleted_at IS NULL AND s.status = 'active' AND s.sold_at >= ? AND s.sold_at < ?`,
    )
    .get(start, end) as { qty: number };

  const byMethod = db
    .prepare(
      `SELECT payment_method AS method, COUNT(*) AS bill_count,
              SUM(total) AS total, SUM(paid) AS paid
         FROM sales
        WHERE deleted_at IS NULL AND status = 'active' AND sold_at >= ? AND sold_at < ?
        GROUP BY payment_method`,
    )
    .all(start, end) as Array<{
    method: PaymentMethod;
    bill_count: number;
    total: number;
    paid: number;
  }>;

  // `localtime` so a shop day is a local day: a sale at 11pm belongs to today,
  // not to tomorrow in UTC.
  const byDay = db
    .prepare(
      `SELECT DATE(sold_at, 'localtime') AS date, COUNT(*) AS bill_count,
              SUM(total) AS net_sales, SUM(total - cost_total) AS gross_profit
         FROM sales
        WHERE deleted_at IS NULL AND status = 'active' AND sold_at >= ? AND sold_at < ?
        GROUP BY DATE(sold_at, 'localtime')
        ORDER BY date`,
    )
    .all(start, end) as Array<{
    date: string;
    bill_count: number;
    net_sales: number;
    gross_profit: number;
  }>;

  const byUser = db
    .prepare(
      `SELECT s.user_id, COALESCE(u.full_name, 'Deleted user') AS user_name,
              COUNT(*) AS bill_count, SUM(s.total) AS net_sales
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.deleted_at IS NULL AND s.status = 'active' AND s.sold_at >= ? AND s.sold_at < ?
        GROUP BY s.user_id
        ORDER BY net_sales DESC`,
    )
    .all(start, end) as Array<{
    user_id: string;
    user_name: string;
    bill_count: number;
    net_sales: number;
  }>;

  // The arithmetic lives in the shared package, because the owner reads these
  // same figures on their phone from a different database. Only the gathering
  // of rows differs between the two.
  const figures = summarisePeriod({
    bills: {
      count: totals.bill_count,
      gross: totals.gross,
      discounts: totals.discounts,
      total: totals.net,
      costTotal: totals.cost,
      paid: totals.paid,
      credit: totals.credit,
    },
    returns: { total: returned.total, costTotal: returned.cost },
    expenses: expensesTotal(db, range.from, range.to),
  });

  return {
    ...figures,
    itemCount: Math.round(items.qty * 1000) / 1000,
    byMethod: byMethod.map((row) => ({
      method: row.method,
      billCount: row.bill_count,
      total: row.total,
      paid: row.paid,
    })),
    byDay: byDay.map((row) => ({
      date: row.date,
      billCount: row.bill_count,
      netSales: row.net_sales,
      grossProfit: row.gross_profit,
    })),
    byUser: byUser.map((row) => ({
      userId: row.user_id,
      userName: row.user_name,
      billCount: row.bill_count,
      netSales: row.net_sales,
    })),
    expenseBreakdown: expensesByCategory(db, range.from, range.to),
  };
}

export interface StockValueRow {
  itemId: string;
  code: string;
  name: string;
  categoryName: string | null;
  unit: string;
  qtyOnHand: number;
  costPrice: number;
  salePrice: number;
  stockCost: number;
  stockRetail: number;
}

/** What the stock on the shelves is worth, at cost and at retail. */
export function stockValue(db: BetterSqlite3.Database): {
  rows: StockValueRow[];
  totalCost: number;
  totalRetail: number;
} {
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name, i.unit, i.qty_on_hand, i.cost_price, i.sale_price,
              c.name AS category_name
         FROM items i
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.deleted_at IS NULL AND i.is_active = 1 AND i.qty_on_hand > 0
        ORDER BY i.qty_on_hand * i.cost_price DESC`,
    )
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    unit: string;
    qty_on_hand: number;
    cost_price: number;
    sale_price: number;
    category_name: string | null;
  }>;

  const mapped = rows.map((row) => ({
    itemId: row.id,
    code: row.code,
    name: row.name,
    categoryName: row.category_name,
    unit: row.unit,
    qtyOnHand: row.qty_on_hand,
    costPrice: row.cost_price,
    salePrice: row.sale_price,
    stockCost: Math.round(row.qty_on_hand * row.cost_price),
    stockRetail: Math.round(row.qty_on_hand * row.sale_price),
  }));

  return {
    rows: mapped,
    totalCost: mapped.reduce((sum, row) => sum + row.stockCost, 0),
    totalRetail: mapped.reduce((sum, row) => sum + row.stockRetail, 0),
  };
}

export interface LowStockRow {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  qtyOnHand: number;
  lowStockLevel: number;
  /** How many were sold in the last 30 days, to sort the urgent ones first. */
  soldLast30: number;
}

export function lowStock(db: BetterSqlite3.Database): LowStockRow[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name, i.unit, i.qty_on_hand, i.low_stock_level,
              COALESCE((
                SELECT SUM(li.qty) FROM sale_items li
                  JOIN sales s ON s.id = li.sale_id
                 WHERE li.item_id = i.id AND s.status = 'active'
                   AND s.sold_at >= datetime('now', '-30 days')
              ), 0) AS sold_last_30
         FROM items i
        WHERE i.deleted_at IS NULL AND i.is_active = 1
          AND i.low_stock_level > 0 AND i.qty_on_hand <= i.low_stock_level
        ORDER BY sold_last_30 DESC, i.qty_on_hand`,
    )
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    unit: string;
    qty_on_hand: number;
    low_stock_level: number;
    sold_last_30: number;
  }>;

  return rows.map((row) => ({
    itemId: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    qtyOnHand: row.qty_on_hand,
    lowStockLevel: row.low_stock_level,
    soldLast30: Math.round(row.sold_last_30 * 1000) / 1000,
  }));
}

export interface BestSellerRow {
  itemId: string;
  code: string;
  name: string;
  qtySold: number;
  revenue: number;
  profit: number;
}

export function bestSellers(
  db: BetterSqlite3.Database,
  range: DateRange,
  limit = 25,
): BestSellerRow[] {
  const { start, end } = rangeToTimestamps(range);
  const rows = db
    .prepare(
      `SELECT li.item_id, li.item_code, li.item_name,
              SUM(li.qty) AS qty_sold,
              SUM(li.line_total) AS revenue,
              SUM(li.line_total - (li.qty * li.cost_price)) AS profit
         FROM sale_items li
         JOIN sales s ON s.id = li.sale_id
        WHERE s.deleted_at IS NULL AND s.status = 'active'
          AND s.sold_at >= ? AND s.sold_at < ?
        GROUP BY li.item_id
        ORDER BY qty_sold DESC
        LIMIT ?`,
    )
    .all(start, end, limit) as Array<{
    item_id: string;
    item_code: string;
    item_name: string;
    qty_sold: number;
    revenue: number;
    profit: number;
  }>;

  return rows.map((row) => ({
    itemId: row.item_id,
    code: row.item_code,
    name: row.item_name,
    qtySold: Math.round(row.qty_sold * 1000) / 1000,
    revenue: row.revenue,
    profit: Math.round(row.profit),
  }));
}

export interface DeadStockRow {
  itemId: string;
  code: string;
  name: string;
  qtyOnHand: number;
  stockCost: number;
  lastSoldAt: string | null;
  daysSinceSale: number | null;
}

/** Money sitting on the shelves that has not moved. */
export function deadStock(db: BetterSqlite3.Database, days = 90): DeadStockRow[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name, i.qty_on_hand, i.cost_price,
              (SELECT MAX(s.sold_at) FROM sale_items li
                 JOIN sales s ON s.id = li.sale_id AND s.status = 'active'
                WHERE li.item_id = i.id) AS last_sold_at
         FROM items i
        WHERE i.deleted_at IS NULL AND i.is_active = 1 AND i.qty_on_hand > 0
        ORDER BY i.qty_on_hand * i.cost_price DESC`,
    )
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    qty_on_hand: number;
    cost_price: number;
    last_sold_at: string | null;
  }>;

  const cutoff = Date.now() - days * 86_400_000;

  return rows
    .filter((row) => !row.last_sold_at || new Date(row.last_sold_at).getTime() < cutoff)
    .map((row) => ({
      itemId: row.id,
      code: row.code,
      name: row.name,
      qtyOnHand: row.qty_on_hand,
      stockCost: Math.round(row.qty_on_hand * row.cost_price),
      lastSoldAt: row.last_sold_at,
      daysSinceSale: row.last_sold_at
        ? Math.floor((Date.now() - new Date(row.last_sold_at).getTime()) / 86_400_000)
        : null,
    }));
}

export interface DuesRow {
  customerId: string;
  name: string;
  phone: string | null;
  balance: number;
  oldestUnpaidAt: string | null;
  daysOutstanding: number;
  lastPaymentAt: string | null;
}

/** Who owes money, how much, and how long it has been outstanding. */
export function customerDues(db: BetterSqlite3.Database): DuesRow[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.balance,
              (SELECT MIN(e.entry_date) FROM customer_ledger_entries e
                WHERE e.customer_id = c.id AND e.deleted_at IS NULL AND e.amount > 0
                  AND e.entry_date > COALESCE((
                    SELECT MAX(p.entry_date) FROM customer_ledger_entries p
                     WHERE p.customer_id = c.id AND p.deleted_at IS NULL AND p.type = 'payment'
                  ), '')
              ) AS oldest_unpaid_at,
              (SELECT MAX(p.received_at) FROM customer_payments p
                WHERE p.customer_id = c.id AND p.deleted_at IS NULL) AS last_payment_at
         FROM customers c
        WHERE c.deleted_at IS NULL AND c.balance > 0
        ORDER BY c.balance DESC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    phone: string | null;
    balance: number;
    oldest_unpaid_at: string | null;
    last_payment_at: string | null;
  }>;

  return rows.map((row) => ({
    customerId: row.id,
    name: row.name,
    phone: row.phone,
    balance: row.balance,
    oldestUnpaidAt: row.oldest_unpaid_at,
    daysOutstanding: row.oldest_unpaid_at
      ? Math.max(0, Math.floor((Date.now() - new Date(row.oldest_unpaid_at).getTime()) / 86_400_000))
      : 0,
    lastPaymentAt: row.last_payment_at,
  }));
}
