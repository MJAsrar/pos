import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, type Unit } from '@pos/shared';

export interface ItemRow {
  id: string;
  code: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  unit: Unit;
  cost_price: number;
  sale_price: number;
  min_price: number | null;
  qty_on_hand: number;
  low_stock_level: number;
  photo_path: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** An item as the rest of the app sees it. Cost is stripped later if not allowed. */
export interface ItemRecord {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  unit: Unit;
  costPrice: number;
  salePrice: number;
  minPrice: number | null;
  qtyOnHand: number;
  lowStockLevel: number;
  photoPath: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function mapItem(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    unit: row.unit,
    costPrice: row.cost_price,
    salePrice: row.sale_price,
    minPrice: row.min_price,
    qtyOnHand: row.qty_on_hand,
    lowStockLevel: row.low_stock_level,
    photoPath: row.photo_path,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `
  SELECT i.*, c.name AS category_name
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id
   WHERE i.deleted_at IS NULL`;

/**
 * Every item, for the billing screen's in-memory search.
 *
 * A few thousand rows is nothing to hold in the renderer, and it means typing in
 * the search box costs zero round trips — the difference between a list that
 * appears instantly and one that stutters while a customer waits.
 */
export function listItems(
  db: BetterSqlite3.Database,
  options: { includeInactive?: boolean } = {},
): ItemRecord[] {
  const clause = options.includeInactive ? '' : ' AND i.is_active = 1';
  const rows = db.prepare(`${SELECT}${clause} ORDER BY i.name`).all() as ItemRow[];
  return rows.map(mapItem);
}

export function findItemById(db: BetterSqlite3.Database, id: string): ItemRecord | null {
  const row = db.prepare(`${SELECT} AND i.id = ?`).get(id) as ItemRow | undefined;
  return row ? mapItem(row) : null;
}

export function findItemByCode(db: BetterSqlite3.Database, code: string): ItemRecord | null {
  const row = db.prepare(`${SELECT} AND i.code = ? COLLATE NOCASE`).get(code) as ItemRow | undefined;
  return row ? mapItem(row) : null;
}

export interface InsertItemInput {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  unit: Unit;
  costPrice: number;
  salePrice: number;
  minPrice: number | null;
  lowStockLevel: number;
  photoPath: string | null;
}

export function insertItem(db: BetterSqlite3.Database, input: InsertItemInput): void {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO items
       (id, code, name, category_id, unit, cost_price, sale_price, min_price,
        qty_on_hand, low_stock_level, photo_path, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`,
  ).run(
    input.id,
    input.code,
    input.name,
    input.categoryId,
    input.unit,
    input.costPrice,
    input.salePrice,
    input.minPrice,
    input.lowStockLevel,
    input.photoPath,
    timestamp,
    timestamp,
  );
}

export interface UpdateItemInput extends Omit<InsertItemInput, 'id'> {
  id: string;
  isActive: boolean;
}

/**
 * Update an item's details.
 *
 * Deliberately does not touch `qty_on_hand`: stock only ever moves by recording
 * a movement, so that the quantity always has an explanation behind it.
 */
export function updateItem(db: BetterSqlite3.Database, input: UpdateItemInput): void {
  db.prepare(
    `UPDATE items
        SET code = ?, name = ?, category_id = ?, unit = ?, cost_price = ?,
            sale_price = ?, min_price = ?, low_stock_level = ?, photo_path = ?,
            is_active = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    input.code,
    input.name,
    input.categoryId,
    input.unit,
    input.costPrice,
    input.salePrice,
    input.minPrice,
    input.lowStockLevel,
    input.photoPath,
    input.isActive ? 1 : 0,
    nowIso(),
    input.id,
  );
}

export function softDeleteItem(db: BetterSqlite3.Database, id: string): void {
  const timestamp = nowIso();
  db.prepare(`UPDATE items SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?`).run(
    timestamp,
    timestamp,
    id,
  );
}

/** Has this item ever been sold? Decides delete versus deactivate. */
export function itemHasHistory(db: BetterSqlite3.Database, id: string): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM sale_items WHERE item_id = ?) AS used`,
    )
    .get(id) as { used: number };
  return row.used === 1;
}

export function codeInUse(db: BetterSqlite3.Database, code: string, exceptId?: string): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM items
          WHERE code = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?
       ) AS used`,
    )
    .get(code, exceptId ?? null) as { used: number };
  return row.used === 1;
}

/**
 * Suggest the next free numeric code.
 *
 * Staff type codes constantly, so short numbers matter. This finds the highest
 * purely numeric code in use and adds one, leaving lettered codes alone.
 */
export function suggestNextCode(db: BetterSqlite3.Database): string {
  const row = db
    .prepare(
      `SELECT MAX(CAST(code AS INTEGER)) AS highest
         FROM items
        WHERE deleted_at IS NULL AND code GLOB '[0-9]*' AND CAST(code AS INTEGER) > 0`,
    )
    .get() as { highest: number | null };
  return String(Math.max(row.highest ?? 100, 100) + 1);
}
