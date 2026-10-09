import type BetterSqlite3 from 'better-sqlite3';
import { rupeesToPaisa, type Unit, UNITS } from '@pos/shared';
import { AppError } from '../errors.js';
import { codeInUse, findItemByCode } from '../db/repos/itemRepo.js';
import { createCategory, createItem, listCategories, saveItem } from './itemService.js';
import { writeAudit } from './auditService.js';

/**
 * Bringing an item list in from Excel.
 *
 * The shop is moving off paper, so the first real list will be typed into a
 * spreadsheet by somebody who is not thinking about data formats. This parser
 * is therefore forgiving about column names, order and spelling, and refuses
 * only what it genuinely cannot understand — reporting the row number, so the
 * person can fix their file rather than guess.
 */

export interface ImportRow {
  line: number;
  code: string;
  name: string;
  unit: Unit;
  costPrice: number;
  salePrice: number;
  openingQty: number;
  lowStockLevel: number;
  /** As written in the file. Empty when the file has no category column. */
  categoryName: string;
  /** Set when that category already exists; null means it will be created. */
  categoryId: string | null;
  /** Set when this code already exists and would be updated rather than added. */
  existingId: string | null;
}

export interface ImportPreview {
  rows: ImportRow[];
  problems: Array<{ line: number; message: string }>;
  toAdd: number;
  toUpdate: number;
  /** Categories named in the file that do not exist yet and will be created. */
  newCategories: string[];
}

/** Column aliases, so "Sale Price", "price" and "rate" all mean the same thing. */
const FIELDS: Record<string, string[]> = {
  code: ['code', 'item code', 'itemcode', 'sku', 'no', 'number'],
  name: ['name', 'item', 'item name', 'description', 'product'],
  unit: ['unit', 'sold by', 'uom'],
  cost: ['cost', 'cost price', 'purchase', 'purchase price', 'buy', 'buying price'],
  price: ['price', 'sale price', 'selling price', 'rate', 'mrp', 'retail'],
  qty: ['qty', 'quantity', 'stock', 'in stock', 'opening', 'opening stock', 'balance'],
  low: ['low', 'low stock', 'reorder', 'reorder level', 'minimum', 'min stock'],
  category: ['category', 'categories', 'group', 'type', 'section'],
};

export function parseItemCsv(db: BetterSqlite3.Database, text: string): ImportPreview {
  const lines = splitLines(text);
  if (lines.length < 2) {
    throw new AppError('empty_file', 'That file has no rows in it.');
  }

  const header = parseLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const column = (field: keyof typeof FIELDS): number =>
    header.findIndex((cell) => FIELDS[field]!.includes(cell));

  const codeAt = column('code');
  const nameAt = column('name');
  const priceAt = column('price');

  if (nameAt === -1 || priceAt === -1) {
    throw new AppError(
      'missing_columns',
      'The file needs at least a "name" column and a "price" column. ' +
        `Found: ${header.filter(Boolean).join(', ') || 'nothing'}.`,
    );
  }

  const unitAt = column('unit');
  const costAt = column('cost');
  const qtyAt = column('qty');
  const lowAt = column('low');
  const categoryAt = column('category');

  // Match categories by name, case- and space-insensitively, so "A.C Parts"
  // in a spreadsheet lands in the "A.C Parts" the shop already has rather than
  // quietly creating a near-duplicate.
  const existingCategories = new Map(
    listCategories(db).map((category) => [categoryKey(category.name), category]),
  );

  const rows: ImportRow[] = [];
  const problems: Array<{ line: number; message: string }> = [];
  const seenCodes = new Set<string>();
  const newCategories = new Map<string, string>();

  for (let index = 1; index < lines.length; index++) {
    const raw = lines[index]!;
    if (!raw.trim()) continue;

    const line = index + 1;
    const cells = parseLine(raw);
    const at = (position: number): string => (position === -1 ? '' : (cells[position] ?? '').trim());

    const name = at(nameAt);
    if (!name) {
      problems.push({ line, message: 'No item name.' });
      continue;
    }
    // The same rule the item service enforces. Catching it here means the
    // person sees the line number in the preview, instead of the whole import
    // refusing at the last moment.
    if (name.length < 2) {
      problems.push({ line, message: `"${name}": the name is too short.` });
      continue;
    }

    const price = parseNumber(at(priceAt));
    if (price === null) {
      problems.push({ line, message: `"${name}": the price "${at(priceAt)}" is not a number.` });
      continue;
    }

    const code = (at(codeAt) || autoCode(db, seenCodes)).toUpperCase();
    if (seenCodes.has(code)) {
      problems.push({ line, message: `"${name}": code ${code} is used twice in this file.` });
      continue;
    }
    seenCodes.add(code);

    const unitText = at(unitAt).toLowerCase();
    const unit = (UNITS as readonly string[]).includes(unitText) ? (unitText as Unit) : 'pcs';

    const existing = findItemByCode(db, code);

    const categoryName = at(categoryAt);
    const matched = categoryName ? existingCategories.get(categoryKey(categoryName)) : undefined;
    if (categoryName && !matched) newCategories.set(categoryKey(categoryName), categoryName);

    rows.push({
      line,
      code,
      name,
      unit,
      costPrice: rupeesToPaisa(parseNumber(at(costAt)) ?? 0),
      salePrice: rupeesToPaisa(price),
      openingQty: parseNumber(at(qtyAt)) ?? 0,
      lowStockLevel: parseNumber(at(lowAt)) ?? 0,
      categoryName,
      categoryId: matched?.id ?? null,
      existingId: existing?.id ?? null,
    });
  }

  return {
    rows,
    problems,
    toAdd: rows.filter((row) => !row.existingId).length,
    toUpdate: rows.filter((row) => row.existingId).length,
    newCategories: [...newCategories.values()],
  };
}

/** Compare category names ignoring case, spacing and punctuation. */
function categoryKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface ImportResult {
  added: number;
  updated: number;
  failed: Array<{ line: number; message: string }>;
}

/**
 * Apply a parsed list.
 *
 * All of it in one transaction: a half-loaded item list is worse than none,
 * because nobody can tell which half arrived.
 */
export function applyItemImport(
  db: BetterSqlite3.Database,
  rows: readonly ImportRow[],
  userId: string,
): ImportResult {
  const failed: Array<{ line: number; message: string }> = [];
  let added = 0;
  let updated = 0;

  db.transaction(() => {
    // Create any category the file names but the shop does not have yet, once,
    // before the items that need it.
    const resolved = new Map<string, string>();
    for (const category of listCategories(db)) {
      resolved.set(categoryKey(category.name), category.id);
    }
    for (const row of rows) {
      const key = row.categoryName ? categoryKey(row.categoryName) : '';
      if (key && !resolved.has(key)) {
        resolved.set(key, createCategory(db, row.categoryName, userId).id);
      }
    }

    const categoryFor = (row: ImportRow): string | null =>
      row.categoryName ? (resolved.get(categoryKey(row.categoryName)) ?? null) : row.categoryId;

    for (const row of rows) {
      try {
        if (row.existingId) {
          saveItem(
            db,
            {
              id: row.existingId,
              code: row.code,
              name: row.name,
              categoryId: categoryFor(row),
              unit: row.unit,
              costPrice: row.costPrice,
              salePrice: row.salePrice,
              minPrice: null,
              lowStockLevel: row.lowStockLevel,
              photoPath: null,
            },
            userId,
          );
          updated++;
        } else {
          createItem(
            db,
            {
              code: row.code,
              name: row.name,
              categoryId: categoryFor(row),
              unit: row.unit,
              costPrice: row.costPrice,
              salePrice: row.salePrice,
              minPrice: null,
              lowStockLevel: row.lowStockLevel,
              photoPath: null,
              openingQty: row.openingQty,
            },
            userId,
          );
          added++;
        }
      } catch (cause) {
        failed.push({
          line: row.line,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    if (failed.length > 0) {
      throw new AppError(
        'import_failed',
        `Nothing was imported. ${failed.length} row(s) could not be read: ` +
          failed
            .slice(0, 3)
            .map((problem) => `line ${problem.line}, ${problem.message}`)
            .join('; '),
      );
    }

    writeAudit(db, {
      userId,
      action: 'item.import',
      entity: 'item',
      entityId: 'multiple',
      summary: `Imported an item list: ${added} added, ${updated} updated`,
    });
  })();

  return { added, updated, failed };
}

function splitLines(text: string): string[] {
  // Handle Windows, Unix and old Mac line endings, and drop a UTF-8 BOM that
  // Excel adds when saving as CSV.
  return text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
}

/** Minimal CSV reader: quoted fields, doubled quotes, comma or semicolon. */
function parseLine(line: string): string[] {
  const separator = line.includes(';') && !line.includes(',') ? ';' : ',';
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === separator) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

/** Accepts `1,250`, `Rs 1250`, `1250.50`, and blanks. */
function parseNumber(value: string): number | null {
  const cleaned = value.replace(/rs\.?/i, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function autoCode(db: BetterSqlite3.Database, seen: Set<string>): string {
  let next = 1000;
  let code = String(next);
  while (seen.has(code) || codeInUse(db, code)) {
    next++;
    code = String(next);
  }
  return code;
}
