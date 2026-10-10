import type BetterSqlite3 from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAYMENT_METHOD_LABELS,
  csvFileName,
  csvRupees,
  figuresCsvRows,
  formatDate,
  toCsv,
  type CsvValue,
  type DateRange,
} from '@pos/shared';
import { exportsDir } from '../paths.js';
import { bestSellers, customerDues, deadStock, lowStock, salesSummary, stockValue } from './reportService.js';

/**
 * Saving a report as a file.
 *
 * One file with everything in it rather than six, because this gets sent to
 * somebody — an accountant, a relative who keeps the books — and six
 * attachments is six chances to send the wrong one.
 *
 * The figures block comes from the shared package, so a file saved here and
 * one saved from the website say the same thing in the same order. Each end
 * adds what only it knows: the counter has the day-by-day breakdown and who
 * sold what, which the website does not.
 *
 * Profit is omitted entirely when the person saving it is not allowed to see
 * it. Blanking the columns would still tell them the shape of the margin, and
 * a file is the easiest thing in the world to send to someone else.
 */

export interface ExportResult {
  fileName: string;
  path: string;
  /** Rows written, so the shop is told something happened. */
  rows: number;
}

export function exportSalesReport(
  db: BetterSqlite3.Database,
  range: DateRange,
  options: { includeProfit: boolean },
): ExportResult {
  const summary = salesSummary(db, range);
  const rows: CsvValue[][] = [
    ['Al Hamza Electronics'],
    [
      range.from === range.to
        ? formatDate(range.from)
        : `${formatDate(range.from)} to ${formatDate(range.to)}`,
    ],
    [],
    ['Sales and profit'],
  ];

  if (options.includeProfit) {
    rows.push(...figuresCsvRows(summary, csvRupees));
  } else {
    // The same order, minus every line that reveals margin.
    rows.push(
      ['Figure', 'Rupees'],
      ['Takings', csvRupees(summary.netSales)],
      ['Money taken', csvRupees(summary.cashTaken)],
      ['Went on udhaar', csvRupees(summary.onCredit)],
      ['Returns', csvRupees(summary.returns)],
      ['Discounts given', csvRupees(summary.discounts)],
      ['Bills', summary.billCount],
    );
  }

  if (summary.byDay.length) {
    rows.push([], ['Day by day'], ['Date', 'Bills', 'Takings', ...(options.includeProfit ? ['Profit on goods'] : [])]);
    for (const day of summary.byDay) {
      rows.push([
        day.date,
        day.billCount,
        csvRupees(day.netSales),
        ...(options.includeProfit ? [csvRupees(day.grossProfit)] : []),
      ]);
    }
  }

  if (summary.byMethod.length) {
    rows.push([], ['How they paid'], ['Method', 'Bills', 'Total', 'Settled']);
    for (const method of summary.byMethod) {
      // The words the shop uses, not the value stored in the column.
      rows.push([
        PAYMENT_METHOD_LABELS[method.method] ?? method.method,
        method.billCount,
        csvRupees(method.total),
        csvRupees(method.paid),
      ]);
    }
  }

  if (summary.byUser.length) {
    rows.push([], ['Who sold'], ['Person', 'Bills', 'Takings']);
    for (const seller of summary.byUser) {
      rows.push([seller.userName, seller.billCount, csvRupees(seller.netSales)]);
    }
  }

  const sold = bestSellers(db, range, 100);
  if (sold.length) {
    rows.push([], ['What sold'], ['Code', 'Item', 'Sold', 'Takings', ...(options.includeProfit ? ['Profit'] : [])]);
    for (const row of sold) {
      rows.push([
        row.code,
        row.name,
        row.qtySold,
        csvRupees(row.revenue),
        ...(options.includeProfit ? [csvRupees(row.profit)] : []),
      ]);
    }
  }

  const shelves = stockValue(db);
  if (shelves.rows.length) {
    rows.push(
      [],
      ['On the shelves'],
      ['Code', 'Item', 'Left', ...(options.includeProfit ? ['At cost'] : []), 'At selling price'],
    );
    for (const row of shelves.rows) {
      rows.push([
        row.code,
        row.name,
        row.qtyOnHand,
        ...(options.includeProfit ? [csvRupees(row.stockCost)] : []),
        csvRupees(row.stockRetail),
      ]);
    }
  }

  const low = lowStock(db);
  if (low.length) {
    rows.push([], ['Running low'], ['Code', 'Item', 'Left', 'Order at']);
    for (const row of low) rows.push([row.code, row.name, row.qtyOnHand, row.lowStockLevel]);
  }

  const idle = deadStock(db);
  if (idle.length) {
    rows.push(
      [],
      ['Not moving'],
      ['Code', 'Item', 'Left', ...(options.includeProfit ? ['At cost'] : []), 'Days since it sold'],
    );
    for (const row of idle) {
      rows.push([
        row.code,
        row.name,
        row.qtyOnHand,
        ...(options.includeProfit ? [csvRupees(row.stockCost)] : []),
        row.daysSinceSale ?? 'never sold',
      ]);
    }
  }

  const owed = customerDues(db);
  if (owed.length) {
    rows.push([], ['Owed to the shop'], ['Customer', 'Phone', 'Owed', 'Days waiting']);
    for (const row of owed) {
      rows.push([row.name, row.phone, csvRupees(row.balance), row.daysOutstanding]);
    }
  }

  const fileName = csvFileName('report', range.from, range.to);
  const path = join(exportsDir(), fileName);
  writeFileSync(path, toCsv(rows), 'utf8');

  return { fileName, path, rows: rows.length };
}
