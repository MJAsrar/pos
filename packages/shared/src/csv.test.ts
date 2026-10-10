import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvFileName, csvRupees, toCsv } from './csv.js';

/**
 * A report the owner cannot open, or opens to find mangled, is worse than no
 * report: they would act on it. These are the cases where a naive join on
 * commas gives a file that looks fine until the one row that matters.
 */

const body = (csv: string) => csv.slice(CSV_BOM.length).trimEnd().split('\r\n');

describe('toCsv', () => {
  it('writes plain rows plainly', () => {
    expect(body(toCsv([['Item', 'Sold'], ['Compressor', '3']]))).toEqual([
      'Item,Sold',
      'Compressor,3',
    ]);
  });

  it('quotes a value containing a comma, rather than splitting the row', () => {
    // Real item names in this shop have commas and inches in them.
    expect(body(toCsv([['Pipe 1/4, 3 metre', '2']]))).toEqual(['"Pipe 1/4, 3 metre",2']);
  });

  it('doubles a quote inside a value', () => {
    expect(body(toCsv([['Pipe 1/4" copper', '5']]))).toEqual(['"Pipe 1/4"" copper",5']);
  });

  it('keeps a value with a newline in one cell', () => {
    const csv = toCsv([['note', 'first\nsecond']]);
    expect(csv.slice(CSV_BOM.length)).toBe('note,"first\nsecond"\r\n');
  });

  it('stops a value being treated as a formula', () => {
    // A field beginning with = is executed when the file is opened, which is
    // a way to attack whoever opens it, not just a display oddity.
    for (const dangerous of ['=1+1', '+SUM(A1)', '-2', '@import']) {
      expect(body(toCsv([[dangerous]]))[0]).toBe(`'${dangerous}`);
    }
  });

  it('leaves an ordinary negative number alone in a number column', () => {
    // csvRupees produces the string, so a loss still reads as a number.
    expect(csvRupees(-4000)).toBe('-40.00');
    // But as a raw cell it is defused, because a leading - is a formula to
    // Excel. The two together mean money columns are written with csvRupees.
    expect(body(toCsv([[csvRupees(-4000)]]))[0]).toBe("'-40.00");
  });

  it('writes empty for nothing, rather than the word undefined', () => {
    expect(body(toCsv([['a', null, undefined, '', 0]]))).toEqual(['a,,,,0']);
  });

  it('starts with a byte-order mark so Excel reads it as UTF-8', () => {
    expect(toCsv([['a']]).startsWith(CSV_BOM)).toBe(true);
  });

  it('ends with a line break, which some readers insist on', () => {
    expect(toCsv([['a']]).endsWith('\r\n')).toBe(true);
  });
});

describe('csvRupees', () => {
  it('writes paisa as rupees a spreadsheet can add up', () => {
    expect(csvRupees(125_000)).toBe('1250.00');
    expect(csvRupees(5)).toBe('0.05');
    expect(csvRupees(0)).toBe('0.00');
  });

  it('keeps both decimal places', () => {
    expect(csvRupees(10)).toBe('0.10');
    expect(csvRupees(1)).toBe('0.01');
  });

  it('carries a loss through as negative', () => {
    expect(csvRupees(-125_000)).toBe('-1250.00');
    expect(csvRupees(-1)).toBe('-0.01');
  });

  it('has no thousands separators, so it parses anywhere', () => {
    expect(csvRupees(1_234_567)).toBe('12345.67');
  });
});

describe('csvFileName', () => {
  it('names a single day by that day', () => {
    expect(csvFileName('Takings', '2026-10-10', '2026-10-10')).toBe(
      'al-hamza-takings-2026-10-10.csv',
    );
  });

  it('names a range by both ends', () => {
    expect(csvFileName('Best sellers', '2026-10-04', '2026-10-10')).toBe(
      'al-hamza-best-sellers-2026-10-04-to-2026-10-10.csv',
    );
  });

  it('has no spaces or oddities, because these get sent through WhatsApp', () => {
    const name = csvFileName('Who owes / what?', '2026-10-10', '2026-10-10');
    expect(name).toBe('al-hamza-who-owes-what-2026-10-10.csv');
    expect(/^[a-z0-9.-]+$/.test(name)).toBe(true);
  });
});
