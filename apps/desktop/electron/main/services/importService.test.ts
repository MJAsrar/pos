import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { listItems } from '../db/repos/itemRepo.js';
import { createCategory, listCategories } from './itemService.js';
import { makeItem, makeTestDb, makeUser, qtyOf } from '../testing/harness.js';
import { applyItemImport, parseItemCsv } from './importService.js';

let db: BetterSqlite3.Database;
let userId: string;

beforeEach(() => {
  db = makeTestDb();
  userId = makeUser(db);
});

afterEach(() => db.close());

/** Join rows with real newlines, the way a saved spreadsheet would. */
const csv = (...lines: string[]): string => lines.join('\n');
const parse = (text: string) => parseItemCsv(db, text);

describe('parseItemCsv column matching', () => {
  it('reads a straightforward file', () => {
    const preview = parse(csv('Code,Name,Cost,Price,Qty', '101,USB-C Cable,120,250,48'));
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      code: '101',
      name: 'USB-C Cable',
      costPrice: 12000,
      salePrice: 25000,
      openingQty: 48,
    });
  });

  it('accepts the other names people actually use for the columns', () => {
    const preview = parse(
      csv('Item Code;Product;Purchase Price;Rate;Stock', 'W25;Wire 2.5mm;68;110;185'),
    );
    expect(preview.rows[0]).toMatchObject({ code: 'W25', name: 'Wire 2.5mm', salePrice: 11000 });
  });

  it('does not care about column order', () => {
    const preview = parse(csv('Price,Name,Code', '250,USB-C Cable,101'));
    expect(preview.rows[0]).toMatchObject({ code: '101', name: 'USB-C Cable', salePrice: 25000 });
  });

  it('refuses a file with no name or price column, saying what it did find', () => {
    expect(() => parse(csv('Thing,Amount', 'a,1'))).toThrow(/name.*price/i);
    expect(() => parse(csv('Thing,Amount', 'a,1'))).toThrow(/thing, amount/i);
  });

  it('refuses an empty file', () => {
    expect(() => parse('')).toThrow(AppError);
    expect(() => parse('Name,Price')).toThrow(/no rows/i);
  });
});

describe('parseItemCsv value handling', () => {
  it('survives what Excel puts in the file', () => {
    const preview = parseItemCsv(
      db,
      [
        '﻿Name,Price,Cost,Qty', // byte-order mark
        '"Cable, 1m","1,250","Rs 900",10', // quoted comma, thousands separator, currency
        'Plain Item,250,120,5',
      ].join('\r\n'), // Windows line endings
    );
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({
      name: 'Cable, 1m',
      salePrice: 125000,
      costPrice: 90000,
    });
    expect(preview.rows[1]?.name).toBe('Plain Item');
  });

  it('handles a doubled quote inside a quoted field', () => {
    const preview = parse(csv('Name,Price', '"6"" Fan",2300'));
    expect(preview.rows[0]?.name).toBe('6" Fan');
  });

  it('skips blank lines rather than failing on them', () => {
    const preview = parse(csv('Name,Price', 'Alpha,10', '', '   ', 'Beta,20'));
    expect(preview.rows).toHaveLength(2);
  });

  it('defaults the unit to pieces and accepts a known one', () => {
    const preview = parse(csv('Name,Price,Unit', 'Wire,10,mtr', 'Bulb,20,nonsense', 'Tape,30,'));
    expect(preview.rows.map((row) => row.unit)).toEqual(['mtr', 'pcs', 'pcs']);
  });

  it('gives an item a code when the file has none', () => {
    const preview = parse(csv('Name,Price', 'Alpha,10', 'Beta,20'));
    const codes = preview.rows.map((row) => row.code);
    expect(codes).toHaveLength(2);
    expect(new Set(codes).size).toBe(2);
  });
});

describe('parseItemCsv problems', () => {
  it('reports the line number of a row it cannot read, and keeps the rest', () => {
    const preview = parse(
      csv('Name,Price', 'Good Item,250', 'Bad Item,abc', ',500', 'Another Good,100'),
    );
    expect(preview.rows.map((row) => row.name)).toEqual(['Good Item', 'Another Good']);
    expect(preview.problems).toEqual([
      { line: 3, message: '"Bad Item": the price "abc" is not a number.' },
      { line: 4, message: 'No item name.' },
    ]);
  });

  it('flags a name too short for the item service to accept', () => {
    // Caught at preview rather than at apply time, so the person sees which
    // line to fix instead of the whole import refusing at the last moment.
    const preview = parse(csv('Name,Price', 'A,10', 'Proper Name,20'));
    expect(preview.rows).toHaveLength(1);
    expect(preview.problems[0]).toEqual({ line: 2, message: '"A": the name is too short.' });
  });

  it('catches a code used twice in the same file', () => {
    const preview = parse(csv('Code,Name,Price', '101,First,10', '101,Second,20'));
    expect(preview.rows).toHaveLength(1);
    expect(preview.problems[0]?.message).toMatch(/used twice/i);
  });

  it('marks a code that already exists as an update, not an addition', () => {
    makeItem(db, userId, { code: '101', name: 'Old Name' });
    const preview = parse(csv('Code,Name,Price', '101,New Name,300', '999,Brand New,50'));
    expect(preview.toUpdate).toBe(1);
    expect(preview.toAdd).toBe(1);
    expect(preview.rows[0]?.existingId).toBeTruthy();
  });
});

describe('applyItemImport', () => {
  it('adds new items with their opening stock', () => {
    const preview = parse(csv('Code,Name,Price,Cost,Qty', '101,USB Cable,250,120,48'));
    expect(applyItemImport(db, preview.rows, userId)).toMatchObject({ added: 1, updated: 0 });

    const item = listItems(db).find((row) => row.code === '101');
    expect(item).toMatchObject({ name: 'USB Cable', salePrice: 25000, costPrice: 12000 });
    expect(qtyOf(db, item!.id)).toBe(48);
  });

  it('updates an existing item without touching its stock', () => {
    const id = makeItem(db, userId, { code: '101', name: 'Old Name', salePrice: 10000, qty: 30 });
    const preview = parse(csv('Code,Name,Price,Qty', '101,New Name,300,999'));

    expect(applyItemImport(db, preview.rows, userId)).toMatchObject({ added: 0, updated: 1 });

    const item = listItems(db).find((row) => row.code === '101');
    expect(item?.name).toBe('New Name');
    expect(item?.salePrice).toBe(30000);
    // The quantity column is ignored on update: stock only ever moves through a
    // recorded movement, never by re-importing a spreadsheet.
    expect(qtyOf(db, id)).toBe(30);
  });

  it('imports all or nothing', () => {
    const preview = parse(csv('Code,Name,Price', '101,Fine,250', '102,Also Fine,300'));
    // Break the second row in a way only the service will catch.
    preview.rows[1]!.code = 'NOT A VALID CODE';

    expect(() => applyItemImport(db, preview.rows, userId)).toThrow(/nothing was imported/i);
    expect(listItems(db)).toHaveLength(0);
  });

  it('records the import in the audit log', () => {
    const preview = parse(csv('Name,Price', 'Alpha,10'));
    applyItemImport(db, preview.rows, userId);

    const entry = db
      .prepare(`SELECT summary FROM audit_log WHERE action = 'item.import'`)
      .get() as { summary: string } | undefined;
    expect(entry?.summary).toMatch(/1 added/);
  });
});

describe('categories in an imported file', () => {
  it('files items into a category that already exists, matching loosely', () => {
    createCategory(db, 'A.C Parts', userId);
    // Different case and spacing must still find the same category.
    const preview = parse(csv('Category,Name,Price', 'ac parts,AC Remote,900'));

    expect(preview.newCategories).toEqual([]);
    expect(preview.rows[0]?.categoryId).toBeTruthy();

    applyItemImport(db, preview.rows, userId);
    expect(listItems(db)[0]?.categoryName).toBe('A.C Parts');
  });

  it('creates a category the shop does not have yet, once', () => {
    const preview = parse(
      csv('Category,Name,Price', 'Heater,Heater Element,800', 'Heater,Immersion Rod,950'),
    );
    expect(preview.newCategories).toEqual(['Heater']);

    applyItemImport(db, preview.rows, userId);
    const made = listCategories(db).filter((c) => c.name === 'Heater');
    expect(made).toHaveLength(1);
    expect(made[0]?.itemCount).toBe(2);
  });

  it('accepts the other words people title that column', () => {
    const preview = parse(csv('Section,Name,Price', 'Tools,Pipe Cutter,1150'));
    expect(preview.rows[0]?.categoryName).toBe('Tools');
  });

  it('leaves items unfiled when the file has no category column', () => {
    const preview = parse(csv('Name,Price', 'Odd Thing,100'));
    expect(preview.rows[0]?.categoryName).toBe('');
    applyItemImport(db, preview.rows, userId);
    expect(listItems(db)[0]?.categoryId).toBeNull();
  });

  it('files an updated item too, not just a new one', () => {
    const id = makeItem(db, userId, { code: '101', name: 'Old' });
    expect(listItems(db).find((i) => i.id === id)?.categoryId).toBeNull();

    const preview = parse(csv('Category,Code,Name,Price', 'Capacitor,101,Capacitor China,200'));
    applyItemImport(db, preview.rows, userId);

    expect(listItems(db).find((i) => i.id === id)?.categoryName).toBe('Capacitor');
  });
});
