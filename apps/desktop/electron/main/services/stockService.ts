import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7, type StockMovementType } from '@pos/shared';
import { AppError } from '../errors.js';
import { findItemById } from '../db/repos/itemRepo.js';
import { writeAudit } from './auditService.js';

/**
 * Stock movements.
 *
 * Stock is never set to a number. Every change is a signed delta with a reason
 * attached, and `items.qty_on_hand` is only a running cache of those deltas.
 *
 * Two things fall out of that, both of which matter more than the small extra
 * cost of writing a row. "Why is this item at 3 and not 5?" is always answerable.
 * And when Stage 2 sync arrives, deltas from two sources add up correctly,
 * whereas two devices each writing an absolute quantity silently lose a day of
 * sales to whichever wrote last.
 */

export interface MovementInput {
  itemId: string;
  type: StockMovementType;
  /** Signed: negative for a sale, positive for stock coming in. */
  qtyDelta: number;
  unitCost?: number | null;
  supplierName?: string | null;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  userId: string;
}

/**
 * Write one movement and roll the cache forward.
 *
 * MUST be called inside an open transaction. The movement row and the cache
 * update have to land together or the cache is a lie.
 */
export function recordMovement(
  db: BetterSqlite3.Database,
  input: MovementInput,
): { qtyAfter: number } {
  const current = db
    .prepare(`SELECT qty_on_hand FROM items WHERE id = ? AND deleted_at IS NULL`)
    .get(input.itemId) as { qty_on_hand: number } | undefined;

  if (!current) throw new AppError('not_found', 'That item no longer exists.');

  // Three decimals is the resolution the app accepts for quantities; rounding
  // here stops binary float error accumulating across thousands of movements.
  const qtyAfter = round3(current.qty_on_hand + input.qtyDelta);
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO stock_movements
       (id, item_id, type, qty_delta, qty_after, unit_cost, supplier_name, reason,
        ref_type, ref_id, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(),
    input.itemId,
    input.type,
    round3(input.qtyDelta),
    qtyAfter,
    input.unitCost ?? null,
    input.supplierName ?? null,
    input.reason ?? null,
    input.refType ?? null,
    input.refId ?? null,
    input.userId,
    timestamp,
    timestamp,
  );

  db.prepare(`UPDATE items SET qty_on_hand = ?, updated_at = ? WHERE id = ?`).run(
    qtyAfter,
    timestamp,
    input.itemId,
  );

  return { qtyAfter };
}

export interface StockInInput {
  itemId: string;
  qty: number;
  /** New cost per unit, if the purchase price changed. */
  unitCost?: number | null;
  supplierName?: string | null;
  note?: string | null;
}

/**
 * Receive stock from a supplier.
 *
 * The entered unit cost replaces the item's cost price rather than blending into
 * a weighted average. That is the owner's own mental model — "I bought this lot
 * at 160, so it costs 160" — and because every sale snapshots the cost onto its
 * own line, changing it here can never alter the profit on a bill already rung.
 */
export function stockIn(
  db: BetterSqlite3.Database,
  input: StockInInput,
  userId: string,
): { qtyAfter: number; costPrice: number } {
  if (!(input.qty > 0)) {
    throw new AppError('invalid_qty', 'Enter how many are coming in.');
  }

  const item = findItemById(db, input.itemId);
  if (!item) throw new AppError('not_found', 'That item no longer exists.');

  const newCost = input.unitCost ?? item.costPrice;
  if (newCost < 0) throw new AppError('invalid_cost', 'Cost price cannot be negative.');

  return db.transaction(() => {
    const { qtyAfter } = recordMovement(db, {
      itemId: input.itemId,
      type: 'stock_in',
      qtyDelta: input.qty,
      unitCost: newCost,
      supplierName: input.supplierName ?? null,
      reason: input.note ?? null,
      userId,
    });

    if (newCost !== item.costPrice) {
      db.prepare(`UPDATE items SET cost_price = ?, updated_at = ? WHERE id = ?`).run(
        newCost,
        nowIso(),
        input.itemId,
      );
      writeAudit(db, {
        userId,
        action: 'item.cost_change',
        entity: 'item',
        entityId: item.id,
        summary: `Cost of ${item.name} changed on stock-in`,
        before: { costPrice: item.costPrice },
        after: { costPrice: newCost },
      });
    }

    writeAudit(db, {
      userId,
      action: 'stock.in',
      entity: 'item',
      entityId: item.id,
      summary:
        `Received ${input.qty} ${item.unit} of ${item.name}` +
        (input.supplierName ? ` from ${input.supplierName}` : ''),
      after: { qty: input.qty, unitCost: newCost, qtyAfter },
    });

    return { qtyAfter, costPrice: newCost };
  })();
}

export interface AdjustStockInput {
  itemId: string;
  /** The quantity the shelf actually holds. The delta is derived from it. */
  countedQty: number;
  reason: 'damaged' | 'lost' | 'correction' | 'other';
  note?: string | null;
}

/**
 * Correct stock to a counted quantity.
 *
 * The screen asks for the number on the shelf, because that is what the person
 * holding the items knows. What gets stored is still a delta, so the correction
 * appears in the item's history as an event rather than as a number that
 * changed for no visible reason.
 */
export function adjustStock(
  db: BetterSqlite3.Database,
  input: AdjustStockInput,
  userId: string,
): { qtyAfter: number; qtyDelta: number } {
  if (!Number.isFinite(input.countedQty) || input.countedQty < 0) {
    throw new AppError('invalid_qty', 'Enter the quantity actually in stock.');
  }

  const item = findItemById(db, input.itemId);
  if (!item) throw new AppError('not_found', 'That item no longer exists.');

  const qtyDelta = round3(input.countedQty - item.qtyOnHand);
  if (qtyDelta === 0) {
    throw new AppError('no_change', 'That is already the recorded quantity.');
  }

  return db.transaction(() => {
    const { qtyAfter } = recordMovement(db, {
      itemId: input.itemId,
      type: 'adjustment',
      qtyDelta,
      reason: input.reason,
      userId,
    });

    writeAudit(db, {
      userId,
      action: 'stock.adjust',
      entity: 'item',
      entityId: item.id,
      summary:
        `${item.name} adjusted from ${item.qtyOnHand} to ${input.countedQty} ${item.unit} ` +
        `(${input.reason})`,
      before: { qtyOnHand: item.qtyOnHand },
      after: { qtyOnHand: qtyAfter, reason: input.reason, note: input.note ?? null },
    });

    return { qtyAfter, qtyDelta };
  })();
}

/** Set the starting quantity when the shop first enters an item. */
export function recordOpeningStock(
  db: BetterSqlite3.Database,
  itemId: string,
  qty: number,
  userId: string,
): void {
  if (qty === 0) return;
  recordMovement(db, {
    itemId,
    type: 'opening',
    qtyDelta: qty,
    reason: 'Opening stock',
    userId,
  });
}

export interface MovementHistoryRow {
  id: string;
  type: StockMovementType;
  qtyDelta: number;
  qtyAfter: number;
  unitCost: number | null;
  supplierName: string | null;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  refLabel: string | null;
  userName: string;
  createdAt: string;
}

/** Everything that ever moved this item, newest first. */
export function itemHistory(
  db: BetterSqlite3.Database,
  itemId: string,
  limit = 200,
): MovementHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.type, m.qty_delta, m.qty_after, m.unit_cost, m.supplier_name,
              m.reason, m.ref_type, m.ref_id, m.created_at,
              COALESCE(u.full_name, 'Deleted user') AS user_name,
              s.invoice_no AS ref_label
         FROM stock_movements m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN sales s ON m.ref_type = 'sale' AND s.id = m.ref_id
        WHERE m.item_id = ? AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(itemId, limit) as Array<Record<string, never>>;

  return (rows as unknown as Array<{
    id: string;
    type: StockMovementType;
    qty_delta: number;
    qty_after: number;
    unit_cost: number | null;
    supplier_name: string | null;
    reason: string | null;
    ref_type: string | null;
    ref_id: string | null;
    ref_label: string | null;
    user_name: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    type: row.type,
    qtyDelta: row.qty_delta,
    qtyAfter: row.qty_after,
    unitCost: row.unit_cost,
    supplierName: row.supplier_name,
    reason: row.reason,
    refType: row.ref_type,
    refId: row.ref_id,
    refLabel: row.ref_label,
    userName: row.user_name,
    createdAt: row.created_at,
  }));
}

export interface StockMismatch {
  itemId: string;
  code: string;
  name: string;
  cached: number;
  fromMovements: number;
}

/**
 * Compare every item's cached quantity against the sum of its movements.
 *
 * Powers the "check stock figures" action in Settings. The cache should never
 * drift, because it is only ever written inside the same transaction as the
 * movement — but a cache nobody verifies is a cache nobody should trust.
 */
export function findStockMismatches(db: BetterSqlite3.Database): StockMismatch[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name, i.qty_on_hand AS cached,
              COALESCE(ROUND(SUM(m.qty_delta), 3), 0) AS from_movements
         FROM items i
         LEFT JOIN stock_movements m ON m.item_id = i.id AND m.deleted_at IS NULL
        WHERE i.deleted_at IS NULL
        GROUP BY i.id
       HAVING ABS(i.qty_on_hand - COALESCE(SUM(m.qty_delta), 0)) > 0.0005`,
    )
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    cached: number;
    from_movements: number;
  }>;

  return rows.map((row) => ({
    itemId: row.id,
    code: row.code,
    name: row.name,
    cached: row.cached,
    fromMovements: row.from_movements,
  }));
}

/** Rebuild the cached quantities from the movements. */
export function repairStockCache(db: BetterSqlite3.Database, userId: string): number {
  const mismatches = findStockMismatches(db);
  if (mismatches.length === 0) return 0;

  db.transaction(() => {
    const update = db.prepare(`UPDATE items SET qty_on_hand = ?, updated_at = ? WHERE id = ?`);
    const timestamp = nowIso();
    for (const row of mismatches) {
      update.run(row.fromMovements, timestamp, row.itemId);
    }
    writeAudit(db, {
      userId,
      action: 'stock.repair',
      entity: 'item',
      entityId: 'multiple',
      summary: `Rebuilt stock figures for ${mismatches.length} item(s) from their history`,
      after: mismatches,
    });
  })();

  return mismatches.length;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface StockCountEntry {
  itemId: string;
  countedQty: number;
}

export interface StockCountResult {
  adjusted: number;
  unchanged: number;
  /** Signed total change, so the screen can say what the count did. */
  netChange: number;
}

/**
 * Apply a whole stock-take at once.
 *
 * Counting a shop one item at a time through a dialog is slow enough that it
 * does not get done, and stock figures nobody trusts are worse than none. This
 * takes the counted quantity for many items and writes one adjustment movement
 * per item that actually changed — so a count still leaves the same explainable
 * trail as any other stock change.
 *
 * All of it in a single transaction: a stock-take that half-applied would leave
 * the shop unable to tell which half.
 */
export function applyStockCount(
  db: BetterSqlite3.Database,
  entries: readonly StockCountEntry[],
  userId: string,
): StockCountResult {
  if (entries.length === 0) {
    throw new AppError('nothing_counted', 'No counts were entered.');
  }

  return db.transaction(() => {
    let adjusted = 0;
    let unchanged = 0;
    let netChange = 0;
    const changes: Array<{ name: string; from: number; to: number }> = [];

    for (const entry of entries) {
      if (!Number.isFinite(entry.countedQty) || entry.countedQty < 0) {
        throw new AppError('invalid_qty', 'A counted quantity was not a number.');
      }

      const item = findItemById(db, entry.itemId);
      if (!item) throw new AppError('not_found', 'One of the items no longer exists.');

      const delta = round3(entry.countedQty - item.qtyOnHand);
      if (delta === 0) {
        unchanged++;
        continue;
      }

      recordMovement(db, {
        itemId: entry.itemId,
        type: 'adjustment',
        qtyDelta: delta,
        reason: 'correction',
        userId,
      });

      adjusted++;
      netChange = round3(netChange + delta);
      changes.push({ name: item.name, from: item.qtyOnHand, to: entry.countedQty });
    }

    if (adjusted > 0) {
      writeAudit(db, {
        userId,
        action: 'stock.count',
        entity: 'item',
        entityId: 'multiple',
        summary: `Stock count: ${adjusted} ${adjusted === 1 ? 'item' : 'items'} corrected`,
        after: changes,
      });
    }

    return { adjusted, unchanged, netChange };
  })();
}
