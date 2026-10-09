import type BetterSqlite3 from 'better-sqlite3';
import { formatInvoiceNo, formatPKR, nowIso, sumPaisa, uuidv7, type RefundMethod } from '@pos/shared';
import { AppError } from '../errors.js';
import { findSaleById } from '../db/repos/saleRepo.js';
import { appendLedgerEntry } from './customerService.js';
import { nextCounterValue } from './settingsService.js';
import { getSettings } from './settingsService.js';
import { recordMovement } from './stockService.js';
import { writeAudit } from './auditService.js';

/**
 * Returns against a bill.
 *
 * A return is its own document, not an edit of the original bill. The customer
 * is holding a copy of that bill; changing it after the fact would make the
 * paper and the system disagree. Instead the return references the bill, puts
 * the stock back, and either hands cash over or credits the customer's account.
 */

export interface ReturnLineInput {
  saleItemId: string;
  qty: number;
}

export interface CreateReturnInput {
  saleId: string;
  lines: ReturnLineInput[];
  refundMethod: RefundMethod;
  reason?: string | null;
}

export interface ReturnRecord {
  id: string;
  returnNo: string;
  saleId: string;
  invoiceNo: string;
  customerId: string | null;
  total: number;
  refundMethod: RefundMethod;
  reason: string | null;
  returnedAt: string;
  userName: string;
  lines: Array<{
    id: string;
    itemId: string;
    itemName: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

export function createReturn(
  db: BetterSqlite3.Database,
  input: CreateReturnInput,
  userId: string,
): { returnRecord: ReturnRecord; refundAmount: number; customerBalance: number | null } {
  const sale = findSaleById(db, input.saleId);
  if (!sale) throw new AppError('not_found', 'That bill no longer exists.');
  if (sale.status === 'voided') {
    throw new AppError('sale_voided', 'That bill was cancelled, so there is nothing to return.');
  }
  if (input.lines.length === 0) {
    throw new AppError('empty_return', 'Choose what is being returned.');
  }

  // Resolve each requested line against the original bill, so quantities can
  // never exceed what was actually sold or what is left after earlier returns.
  const resolved = input.lines.map((requested) => {
    const line = sale.lines.find((candidate) => candidate.id === requested.saleItemId);
    if (!line) throw new AppError('line_missing', 'That item is not on this bill.');

    const remaining = round3(line.qty - line.returnedQty);
    if (!(requested.qty > 0)) {
      throw new AppError('invalid_qty', `Enter how many ${line.itemName} are coming back.`);
    }
    if (requested.qty > remaining + 0.0005) {
      throw new AppError(
        'qty_too_high',
        remaining <= 0
          ? `${line.itemName} has already been returned in full.`
          : `Only ${remaining} of ${line.itemName} can still be returned.`,
      );
    }

    return {
      line,
      qty: round3(requested.qty),
      lineTotal: Math.round(requested.qty * line.unitPrice),
      costTotal: Math.round(requested.qty * line.costPrice),
    };
  });

  const total = sumPaisa(resolved.map((entry) => entry.lineTotal));
  const costTotal = sumPaisa(resolved.map((entry) => entry.costTotal));

  if (input.refundMethod === 'credit_note' && !sale.customerId) {
    throw new AppError(
      'no_customer',
      'This bill has no customer, so the refund cannot go to an account. Refund in cash instead.',
    );
  }

  const returnId = uuidv7();

  const outcome = db.transaction(() => {
    const settings = getSettings(db);
    const sequence = nextCounterValue(db, 'return');
    const returnNo = formatInvoiceNo(`${settings.invoicePrefix}R`, sequence);
    const timestamp = nowIso();

    db.prepare(
      `INSERT INTO sale_returns
         (id, return_no, sale_id, customer_id, user_id, returned_at, total, cost_total,
          refund_method, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      returnId,
      returnNo,
      sale.id,
      sale.customerId,
      userId,
      timestamp,
      total,
      costTotal,
      input.refundMethod,
      input.reason?.trim() || null,
      timestamp,
      timestamp,
    );

    const insertLine = db.prepare(
      `INSERT INTO sale_return_items
         (id, return_id, sale_item_id, item_id, item_name, qty, unit_price, cost_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of resolved) {
      insertLine.run(
        uuidv7(),
        returnId,
        entry.line.id,
        entry.line.itemId,
        entry.line.itemName,
        entry.qty,
        entry.line.unitPrice,
        entry.line.costPrice,
        entry.lineTotal,
      );

      recordMovement(db, {
        itemId: entry.line.itemId,
        type: 'return',
        qtyDelta: entry.qty,
        reason: input.reason?.trim() || 'Returned by customer',
        refType: 'return',
        refId: returnId,
        userId,
      });
    }

    let customerBalance: number | null = null;
    if (input.refundMethod === 'credit_note' && sale.customerId) {
      const ledger = appendLedgerEntry(db, {
        customerId: sale.customerId,
        type: 'return_credit',
        amount: total,
        refType: 'return',
        refId: returnId,
        refLabel: returnNo,
        note: `Return against ${sale.invoiceNo}`,
        userId,
      });
      customerBalance = ledger.balanceAfter;
    }

    writeAudit(db, {
      userId,
      action: 'sale.return',
      entity: 'sale',
      entityId: sale.id,
      summary:
        `${returnNo}: ${formatPKR(total)} returned against ${sale.invoiceNo} ` +
        `(${input.refundMethod === 'credit_note' ? 'credited to account' : 'refunded'})`,
      after: {
        returnNo,
        total,
        refundMethod: input.refundMethod,
        lines: resolved.map((entry) => ({ item: entry.line.itemName, qty: entry.qty })),
      },
    });

    return { returnNo, timestamp, customerBalance };
  })();

  return {
    returnRecord: {
      id: returnId,
      returnNo: outcome.returnNo,
      saleId: sale.id,
      invoiceNo: sale.invoiceNo,
      customerId: sale.customerId,
      total,
      refundMethod: input.refundMethod,
      reason: input.reason?.trim() || null,
      returnedAt: outcome.timestamp,
      userName: '',
      lines: resolved.map((entry) => ({
        id: entry.line.id,
        itemId: entry.line.itemId,
        itemName: entry.line.itemName,
        qty: entry.qty,
        unitPrice: entry.line.unitPrice,
        lineTotal: entry.lineTotal,
      })),
    },
    refundAmount: total,
    customerBalance: outcome.customerBalance,
  };
}

/** Every return raised against a bill. */
export function listReturnsForSale(db: BetterSqlite3.Database, saleId: string): ReturnRecord[] {
  const rows = db
    .prepare(
      `SELECT r.*, s.invoice_no, COALESCE(u.full_name, 'Deleted user') AS user_name
         FROM sale_returns r
         JOIN sales s ON s.id = r.sale_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.sale_id = ? AND r.deleted_at IS NULL
        ORDER BY r.returned_at DESC`,
    )
    .all(saleId) as Array<{
    id: string;
    return_no: string;
    sale_id: string;
    invoice_no: string;
    customer_id: string | null;
    total: number;
    refund_method: RefundMethod;
    reason: string | null;
    returned_at: string;
    user_name: string;
  }>;

  const lineStatement = db.prepare(
    `SELECT id, item_id, item_name, qty, unit_price, line_total
       FROM sale_return_items WHERE return_id = ?`,
  );

  return rows.map((row) => ({
    id: row.id,
    returnNo: row.return_no,
    saleId: row.sale_id,
    invoiceNo: row.invoice_no,
    customerId: row.customer_id,
    total: row.total,
    refundMethod: row.refund_method,
    reason: row.reason,
    returnedAt: row.returned_at,
    userName: row.user_name,
    lines: (
      lineStatement.all(row.id) as Array<{
        id: string;
        item_id: string;
        item_name: string;
        qty: number;
        unit_price: number;
        line_total: number;
      }>
    ).map((line) => ({
      id: line.id,
      itemId: line.item_id,
      itemName: line.item_name,
      qty: line.qty,
      unitPrice: line.unit_price,
      lineTotal: line.line_total,
    })),
  }));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
