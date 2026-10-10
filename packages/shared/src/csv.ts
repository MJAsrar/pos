/**
 * Turning a report into a file somebody can open.
 *
 * Shared because both ends offer it and the two files should be identical: the
 * owner may send one from their phone and the cashier save another at the
 * counter, and a difference between them would be a mystery nobody could
 * explain.
 *
 * CSV looks like it needs no library until it does. Three things here are not
 * decoration:
 *
 * Quotes and commas and newlines inside a value are escaped, so an item called
 * `Pipe 1/4", 3 metre` does not silently become two columns.
 *
 * A value that begins with `=`, `+`, `-` or `@` is prefixed with an
 * apostrophe. Excel treats those as formulas, and a field beginning with `=`
 * would be executed on opening rather than read — which is a way to attack
 * whoever opens the file, not merely a display problem.
 *
 * The file starts with a byte-order mark, because without it Excel on Windows
 * reads UTF-8 as the local code page and anything beyond plain ASCII arrives
 * as rubbish.
 */

/** Excel reads a UTF-8 file as the local code page unless it finds this. */
export const CSV_BOM = '﻿';

export type CsvValue = string | number | null | undefined;

function escapeCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const text = String(value);

  // A leading =, +, - or @ makes Excel treat the cell as a formula.
  const defused = /^[=+\-@]/.test(text) ? `'${text}` : text;

  return /[",\r\n]/.test(defused) ? `"${defused.replaceAll('"', '""')}"` : defused;
}

/**
 * One CSV document, ready to be written to a file.
 *
 * Rows are written with CRLF line endings, which is what the format says and
 * what Excel expects; everything else copes either way.
 */
export function toCsv(rows: readonly CsvValue[][]): string {
  return CSV_BOM + rows.map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * A filename that sorts by date and says what it is.
 *
 * `al-hamza-takings-2026-10-04-to-2026-10-10.csv`. No spaces, because these
 * get sent through WhatsApp and attached to emails, and because a shop owner
 * should be able to find last month's by looking rather than opening each one.
 */
export function csvFileName(what: string, from: string, to: string): string {
  const slug = what
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return from === to
    ? `al-hamza-${slug}-${from}.csv`
    : `al-hamza-${slug}-${from}-to-${to}.csv`;
}

/**
 * Money as a plain number of rupees, for a spreadsheet.
 *
 * Not `formatPKR`: a column of "Rs 1,250" cannot be added up by the thing the
 * owner opened it in, which is the only reason to want a file at all. Two
 * decimal places and no separators, so it parses everywhere.
 */
export function csvRupees(paisa: number): string {
  const sign = paisa < 0 ? '-' : '';
  const absolute = Math.abs(Math.round(paisa));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
