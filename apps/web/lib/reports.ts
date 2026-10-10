/**
 * The reports, gathered from the cloud copy.
 *
 * The counter computes these in SQL against SQLite; here the rows are fetched
 * and added up in the browser. That sounds wasteful and is not, at this size:
 * the shop has fifty-odd items and a few hundred bills a month, so a report is
 * a handful of small queries either way.
 *
 * What does matter is that the definitions match the ones at the counter,
 * because the owner will compare them. Each is noted against its counterpart
 * in `reportService.ts`. Where a definition has a subtlety that would be easy
 * to get almost right — an item that has never sold still counts as not
 * moving, a shop day is a day in Dina — it lives in `@pos/shared` and both
 * ends call it.
 *
 * Returns and cancelled bills are handled the same way throughout: a
 * cancelled bill is not a sale, and a return comes off both the takings and
 * the cost.
 */

import {
  daysOutstanding,
  daysSinceSale,
  dueBucket,
  isNotMoving,
  rangeToTimestamps,
  type DateRange,
  type DueBucket,
} from '@pos/shared';
import { listItems, read, type ShopItem } from './shop';

// --- What the shelves are worth -------------------------------------------

export interface StockSnapshot {
  rows: Array<ShopItem & { stockCost: number; stockRetail: number }>;
  totalCost: number;
  totalRetail: number;
  runningLow: ShopItem[];
  nothingLeft: ShopItem[];
}

/** Mirrors `stockValue` and `lowStock` at the counter. */
export async function stockSnapshot(): Promise<StockSnapshot> {
  const items = await listItems();

  const holding = items
    .filter((item) => item.qtyOnHand > 0)
    .map((item) => ({
      ...item,
      stockCost: Math.round(item.qtyOnHand * item.costPrice),
      stockRetail: Math.round(item.qtyOnHand * item.salePrice),
    }))
    .sort((a, b) => b.stockCost - a.stockCost);

  return {
    rows: holding,
    totalCost: holding.reduce((sum, row) => sum + row.stockCost, 0),
    totalRetail: holding.reduce((sum, row) => sum + row.stockRetail, 0),
    // Low but not empty, and empty, kept apart: one is an order to place and
    // the other is a sale already being turned away.
    runningLow: items
      .filter((item) => item.qtyOnHand > 0 && item.qtyOnHand <= item.lowStockLevel)
      .sort((a, b) => a.qtyOnHand - b.qtyOnHand),
    nothingLeft: items.filter((item) => item.qtyOnHand <= 0),
  };
}

// --- What sold --------------------------------------------------------------

interface BillRow {
  id: string;
  sold_at: string;
}

interface LineRow {
  sale_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  qty: number;
  line_total: number;
  cost_price: number;
}

export interface SoldRow {
  itemId: string;
  code: string;
  name: string;
  qty: number;
  takings: number;
  profit: number;
}

/**
 * Best sellers, by quantity. Mirrors `bestSellers` at the counter.
 *
 * The bill rows are fetched to know which lines count: the cloud has no
 * foreign keys — on purpose, so rows can arrive in any order — so the join
 * cannot be asked for and is done here instead.
 */
export async function soldInPeriod(range: DateRange): Promise<SoldRow[]> {
  const { start, end } = rangeToTimestamps(range);

  const bills = await read<BillRow>(
    `sales?select=id,sold_at&status=eq.active&deleted_at=is.null&sold_at=gte.${start}&sold_at=lt.${end}`,
  );
  if (!bills.length) return [];

  const counted = new Set(bills.map((bill) => bill.id));
  const lines = await read<LineRow>(
    `sale_items?select=sale_id,item_id,item_code,item_name,qty,line_total,cost_price&sale_id=in.(${[...counted].join(',')})`,
  );

  const byItem = new Map<string, SoldRow>();
  for (const line of lines) {
    if (!counted.has(line.sale_id)) continue;
    const running = byItem.get(line.item_id) ?? {
      itemId: line.item_id,
      code: line.item_code,
      name: line.item_name,
      qty: 0,
      takings: 0,
      profit: 0,
    };
    running.qty = Math.round((running.qty + line.qty) * 1000) / 1000;
    running.takings += line.line_total;
    // Cost from the snapshot on the line, never the item's cost today, so
    // last month's profit does not move when a supplier raises their price.
    running.profit += line.line_total - Math.round(line.qty * line.cost_price);
    byItem.set(line.item_id, running);
  }

  return [...byItem.values()].sort((a, b) => b.qty - a.qty);
}

// --- What is not moving ----------------------------------------------------

export interface NotMovingRow {
  code: string;
  name: string;
  qtyOnHand: number;
  stockCost: number;
  lastSoldAt: string | null;
  days: number | null;
}

/** Mirrors `deadStock` at the counter, which defaults to ninety days. */
export async function notMoving(days = 90): Promise<NotMovingRow[]> {
  const items = (await listItems()).filter((item) => item.qtyOnHand > 0);
  if (!items.length) return [];

  // The last time each item sold, from active bills only.
  const lines = await read<{ item_id: string; sale_id: string }>(
    'sale_items?select=item_id,sale_id',
  );
  const bills = await read<BillRow>('sales?select=id,sold_at&status=eq.active&deleted_at=is.null');
  const soldAt = new Map(bills.map((bill) => [bill.id, bill.sold_at]));

  const lastSold = new Map<string, string>();
  for (const line of lines) {
    const when = soldAt.get(line.sale_id);
    if (!when) continue;
    const seen = lastSold.get(line.item_id);
    if (!seen || when > seen) lastSold.set(line.item_id, when);
  }

  return items
    .map((item) => {
      const last = lastSold.get(item.id) ?? null;
      return {
        code: item.code,
        name: item.name,
        qtyOnHand: item.qtyOnHand,
        stockCost: Math.round(item.qtyOnHand * item.costPrice),
        lastSoldAt: last,
        days: daysSinceSale(last),
      };
    })
    .filter((row) => isNotMoving(row.lastSoldAt, days))
    .sort((a, b) => b.stockCost - a.stockCost);
}

// --- Who owes, and for how long -------------------------------------------

export interface DueRow {
  name: string;
  phone: string | null;
  balance: number;
  days: number;
  bucket: DueBucket;
}

/** Mirrors `customerDues` at the counter. */
export async function dues(): Promise<{ rows: DueRow[]; total: number }> {
  const owing = await read<{ customer_id: string; name: string; balance: number }>(
    'customer_balance?select=customer_id,name,balance&balance=gt.0',
  );
  if (!owing.length) return { rows: [], total: 0 };

  const entries = await read<{ customer_id: string; entry_date: string; amount: number }>(
    `customer_ledger_entries?select=customer_id,entry_date,amount&deleted_at=is.null` +
      `&customer_id=in.(${owing.map((row) => row.customer_id).join(',')})&amount=gt.0&order=entry_date.asc`,
  );

  const oldest = new Map<string, string>();
  for (const entry of entries) {
    if (!oldest.has(entry.customer_id)) oldest.set(entry.customer_id, entry.entry_date);
  }

  const phones = await read<{ id: string; phone: string | null }>(
    `customers?select=id,phone&id=in.(${owing.map((row) => row.customer_id).join(',')})`,
  );
  const phoneOf = new Map(phones.map((row) => [row.id, row.phone]));

  const rows = owing
    .map((row) => {
      const since = oldest.get(row.customer_id);
      const days = since ? daysOutstanding(since) : 0;
      return {
        name: row.name,
        phone: phoneOf.get(row.customer_id) ?? null,
        balance: row.balance,
        days,
        bucket: dueBucket(days),
      };
    })
    .sort((a, b) => b.days - a.days || b.balance - a.balance);

  return { rows, total: rows.reduce((sum, row) => sum + row.balance, 0) };
}
