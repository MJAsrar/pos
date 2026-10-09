import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7, type Unit } from '@pos/shared';
import { AppError } from '../errors.js';
import {
  codeInUse,
  findItemById,
  insertItem,
  itemHasHistory,
  softDeleteItem,
  updateItem,
  type ItemRecord,
} from '../db/repos/itemRepo.js';
import { recordOpeningStock } from './stockService.js';
import { writeAudit } from './auditService.js';

export interface SaveItemInput {
  /** Omitted when creating. */
  id?: string;
  code: string;
  name: string;
  categoryId: string | null;
  unit: Unit;
  costPrice: number;
  salePrice: number;
  minPrice: number | null;
  lowStockLevel: number;
  photoPath: string | null;
  isActive?: boolean;
  /** Only honoured when creating: the quantity already on the shelf. */
  openingQty?: number;
}

export function createItem(
  db: BetterSqlite3.Database,
  input: SaveItemInput,
  userId: string,
): ItemRecord {
  const code = normaliseCode(input.code);
  const name = input.name.trim();

  validate(db, { ...input, code, name });

  const id = uuidv7();

  db.transaction(() => {
    insertItem(db, {
      id,
      code,
      name,
      categoryId: input.categoryId,
      unit: input.unit,
      costPrice: input.costPrice,
      salePrice: input.salePrice,
      minPrice: input.minPrice,
      lowStockLevel: input.lowStockLevel,
      photoPath: input.photoPath,
    });

    if (input.openingQty && input.openingQty > 0) {
      recordOpeningStock(db, id, input.openingQty, userId);
    }

    writeAudit(db, {
      userId,
      action: 'item.create',
      entity: 'item',
      entityId: id,
      summary: `Added item ${code} — ${name}`,
      after: { code, name, salePrice: input.salePrice, openingQty: input.openingQty ?? 0 },
    });
  })();

  const created = findItemById(db, id);
  if (!created) throw new AppError('internal', 'The item could not be saved.');
  return created;
}

export function saveItem(
  db: BetterSqlite3.Database,
  input: SaveItemInput & { id: string },
  userId: string,
): ItemRecord {
  const existing = findItemById(db, input.id);
  if (!existing) throw new AppError('not_found', 'That item no longer exists.');

  const code = normaliseCode(input.code);
  const name = input.name.trim();
  validate(db, { ...input, code, name });

  db.transaction(() => {
    updateItem(db, {
      id: input.id,
      code,
      name,
      categoryId: input.categoryId,
      unit: input.unit,
      costPrice: input.costPrice,
      salePrice: input.salePrice,
      minPrice: input.minPrice,
      lowStockLevel: input.lowStockLevel,
      photoPath: input.photoPath,
      isActive: input.isActive ?? existing.isActive,
    });

    // Price changes are the thing an owner most often wants to trace later, so
    // they get their own audit line rather than being buried in a generic edit.
    if (existing.salePrice !== input.salePrice || existing.costPrice !== input.costPrice) {
      writeAudit(db, {
        userId,
        action: 'item.price_change',
        entity: 'item',
        entityId: input.id,
        summary: `Prices changed for ${name}`,
        before: { costPrice: existing.costPrice, salePrice: existing.salePrice },
        after: { costPrice: input.costPrice, salePrice: input.salePrice },
      });
    }

    writeAudit(db, {
      userId,
      action: 'item.update',
      entity: 'item',
      entityId: input.id,
      summary: `Edited item ${code} — ${name}`,
      before: existing,
      after: { code, name, unit: input.unit, isActive: input.isActive ?? existing.isActive },
    });
  })();

  const saved = findItemById(db, input.id);
  if (!saved) throw new AppError('internal', 'The item could not be saved.');
  return saved;
}

/**
 * Remove an item.
 *
 * An item that has ever been sold is deactivated rather than deleted — deleting
 * it would orphan the lines on bills the customer is holding a copy of. Only an
 * item that was never sold is actually removed.
 */
export function removeItem(
  db: BetterSqlite3.Database,
  id: string,
  userId: string,
): { deleted: boolean } {
  const item = findItemById(db, id);
  if (!item) throw new AppError('not_found', 'That item no longer exists.');

  const sold = itemHasHistory(db, id);

  db.transaction(() => {
    if (sold) {
      updateItem(db, {
        id,
        code: item.code,
        name: item.name,
        categoryId: item.categoryId,
        unit: item.unit,
        costPrice: item.costPrice,
        salePrice: item.salePrice,
        minPrice: item.minPrice,
        lowStockLevel: item.lowStockLevel,
        photoPath: item.photoPath,
        isActive: false,
      });
    } else {
      softDeleteItem(db, id);
    }

    writeAudit(db, {
      userId,
      action: sold ? 'item.deactivate' : 'item.delete',
      entity: 'item',
      entityId: id,
      summary: sold
        ? `Stopped selling ${item.name} (kept because it appears on past bills)`
        : `Deleted item ${item.code} — ${item.name}`,
      before: item,
    });
  })();

  return { deleted: !sold };
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

function validate(
  db: BetterSqlite3.Database,
  input: SaveItemInput & { code: string; name: string },
): void {
  if (input.name.length < 2) {
    throw new AppError('invalid_name', 'Enter a name for this item.');
  }
  if (!/^[A-Z0-9][A-Z0-9-]{0,23}$/.test(input.code)) {
    throw new AppError(
      'invalid_code',
      'The code must be 1-24 letters, numbers or dashes, with no spaces.',
    );
  }
  if (codeInUse(db, input.code, input.id)) {
    throw new AppError('code_taken', `Code ${input.code} is already used by another item.`);
  }
  if (input.costPrice < 0 || input.salePrice < 0) {
    throw new AppError('invalid_price', 'Prices cannot be negative.');
  }
  if (input.minPrice !== null && input.minPrice > input.salePrice) {
    throw new AppError(
      'invalid_min_price',
      'The minimum price cannot be higher than the sale price.',
    );
  }
  if (input.lowStockLevel < 0) {
    throw new AppError('invalid_low_stock', 'The low-stock level cannot be negative.');
  }
}

// --- Categories ------------------------------------------------------------

export interface CategoryRecord {
  id: string;
  name: string;
  sortOrder: number;
  itemCount: number;
}

export function listCategories(db: BetterSqlite3.Database): CategoryRecord[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.sort_order,
              COUNT(i.id) FILTER (WHERE i.deleted_at IS NULL AND i.is_active = 1) AS item_count
         FROM categories c
         LEFT JOIN items i ON i.category_id = c.id
        WHERE c.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY c.sort_order, c.name`,
    )
    .all() as Array<{ id: string; name: string; sort_order: number; item_count: number }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    itemCount: row.item_count,
  }));
}

export function createCategory(
  db: BetterSqlite3.Database,
  name: string,
  userId: string,
): CategoryRecord {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new AppError('invalid_name', 'Enter a name for this category.');

  const clash = db
    .prepare(`SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .get(trimmed) as { id: string } | undefined;
  if (clash) throw new AppError('name_taken', `There is already a category called "${trimmed}".`);

  const id = uuidv7();
  const timestamp = nowIso();
  const next = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM categories`).get() as {
    next: number;
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, trimmed, next.next, timestamp, timestamp);
    writeAudit(db, {
      userId,
      action: 'category.create',
      entity: 'category',
      entityId: id,
      summary: `Added category "${trimmed}"`,
    });
  })();

  return { id, name: trimmed, sortOrder: next.next, itemCount: 0 };
}

export function renameCategory(
  db: BetterSqlite3.Database,
  id: string,
  name: string,
  userId: string,
): void {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new AppError('invalid_name', 'Enter a name for this category.');

  db.transaction(() => {
    db.prepare(`UPDATE categories SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(
      trimmed,
      nowIso(),
      id,
    );
    writeAudit(db, {
      userId,
      action: 'category.rename',
      entity: 'category',
      entityId: id,
      summary: `Renamed category to "${trimmed}"`,
    });
  })();
}

/** Delete a category. Items in it keep existing and become uncategorised. */
export function removeCategory(db: BetterSqlite3.Database, id: string, userId: string): void {
  const category = db
    .prepare(`SELECT name FROM categories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { name: string } | undefined;
  if (!category) throw new AppError('not_found', 'That category no longer exists.');

  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE items SET category_id = NULL, updated_at = ? WHERE category_id = ?`).run(
      timestamp,
      id,
    );
    db.prepare(`UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(
      timestamp,
      timestamp,
      id,
    );
    writeAudit(db, {
      userId,
      action: 'category.delete',
      entity: 'category',
      entityId: id,
      summary: `Deleted category "${category.name}"`,
    });
  })();
}
