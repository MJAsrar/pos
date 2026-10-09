import type BetterSqlite3 from 'better-sqlite3';
import {
  computeSaleTotals,
  formatInvoiceNo,
  formatPKR,
  hasBlockingIssue,
  nowIso,
  settleSale,
  uuidv7,
  validateSale,
  type DraftLine,
  type PaymentMethod,
} from '@pos/shared';
import { AppError } from '../errors.js';
import { findItemById } from '../db/repos/itemRepo.js';
import { findCustomerById } from '../db/repos/customerRepo.js';
import { findSaleById, type SaleRecord } from '../db/repos/saleRepo.js';
import { appendLedgerEntry } from './customerService.js';
import { getSettings, nextCounterValue } from './settingsService.js';
import { recordMovement } from './stockService.js';
import { writeAudit } from './auditService.js';

/**
 * Making, voiding and returning a bill.
 *
 * `createSale` is the one place in the app where the most things happen at once:
 * a sale row, its lines, a stock movement per line, and possibly a ledger entry.
 * All of it runs inside a single SQLite transaction, so a power cut halfway
 * through leaves no half-written bill, no stock that moved for a sale that does
 * not exist, and no customer charged for goods they were never billed.
 */

export interface SaleLineInput {
  itemId: string;
  qty: number;
  /** What the cashier actually charged. Defaults to the item's sale price. */
  unitPrice?: number;
}

export interface CreateSaleInput {
  lines: SaleLineInput[];
  customerId?: string | null;
  discount?: number;
  paymentMethod: PaymentMethod;
  /** Amount handed over. Less than the total puts the rest on udhaar. */
  tendered?: number;
  note?: string | null;
}

/** What the signed-in user is allowed to do, supplied by the op layer. */
export interface SaleActor {
  id: string;
  canEditPrice: boolean;
  canDiscount: boolean;
  canSellOnCredit: boolean;
}

export interface CreateSaleResult {
  sale: SaleRecord;
  change: number;
  customerBalance: number | null;
}

export function createSale(
  db: BetterSqlite3.Database,
  input: CreateSaleInput,
  actor: SaleActor,
): CreateSaleResult {
  if (input.lines.length === 0) {
    throw new AppError('empty_bill', 'Add at least one item to the bill.');
  }

  const settings = getSettings(db);

  // Prices, costs and stock are read from the database rather than taken from
  // the screen. The cashier may change what is charged; they may not change
  // what an item cost the shop, which is what every profit figure rests on.
  const draft: DraftLine[] = input.lines.map((line) => {
    const item = findItemById(db, line.itemId);
    if (!item) {
      throw new AppError('item_missing', 'An item on this bill no longer exists. Remove it and try again.');
    }
    if (!item.isActive) {
      throw new AppError('item_inactive', `${item.name} is no longer being sold.`);
    }
    return {
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      unit: item.unit,
      qty: line.qty,
      unitPrice: Math.round(line.unitPrice ?? item.salePrice),
      costPrice: item.costPrice,
      minPrice: item.minPrice,
      qtyOnHand: item.qtyOnHand,
    };
  });

  const overrides = draft.filter((line, index) => {
    const requested = input.lines[index]?.unitPrice;
    return requested !== undefined && requested !== defaultPriceFor(db, line.itemId);
  });

  if (overrides.length > 0 && !actor.canEditPrice) {
    throw new AppError(
      'price_change_not_allowed',
      'You are not allowed to change prices. Ask the owner to ring this up.',
    );
  }

  const discount = Math.round(input.discount ?? 0);
  if (discount > 0 && !actor.canDiscount) {
    throw new AppError('discount_not_allowed', 'You are not allowed to give discounts.');
  }

  const totals = computeSaleTotals(draft, discount);
  const settlement = settleSale(totals.total, Math.round(input.tendered ?? 0), input.paymentMethod);

  if (settlement.credit > 0 && !actor.canSellOnCredit) {
    throw new AppError(
      'credit_not_allowed',
      'You are not allowed to put an amount on udhaar. Take the full payment, or ask the owner.',
    );
  }

  const issues = validateSale({
    lines: draft,
    discount,
    customerId: input.customerId ?? null,
    paymentMethod: input.paymentMethod,
    tendered: input.tendered ?? 0,
    enforceMinPrice: settings.enforceMinPrice,
    blockNegativeStock: settings.blockNegativeStock,
    canOverrideMinPrice: actor.canEditPrice,
  });

  if (hasBlockingIssue(issues)) {
    const blocking = issues.filter((issue) => issue.blocking);
    throw new AppError('invalid_sale', blocking.map((issue) => issue.message).join(' '));
  }

  const customer = input.customerId ? findCustomerById(db, input.customerId) : null;
  if (input.customerId && !customer) {
    throw new AppError('not_found', 'That customer no longer exists.');
  }

  const saleId = uuidv7();

  const result = db.transaction(() => {
    const sequence = nextCounterValue(db, 'invoice');
    const invoiceNo = formatInvoiceNo(settings.invoicePrefix, sequence);
    const timestamp = nowIso();

    db.prepare(
      `INSERT INTO sales
         (id, invoice_no, customer_id, user_id, sold_at, subtotal, discount, rounding,
          total, paid, payment_method, cost_total, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      saleId,
      invoiceNo,
      input.customerId ?? null,
      actor.id,
      timestamp,
      totals.subtotal,
      totals.discount,
      totals.rounding,
      totals.total,
      settlement.paid,
      input.paymentMethod,
      totals.costTotal,
      input.note?.trim() || null,
      timestamp,
      timestamp,
    );

    const insertLine = db.prepare(
      `INSERT INTO sale_items
         (id, sale_id, item_id, item_code, item_name, unit, qty, unit_price, cost_price,
          line_total, line_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    draft.forEach((line, index) => {
      insertLine.run(
        uuidv7(),
        saleId,
        line.itemId,
        line.itemCode,
        line.itemName,
        line.unit,
        line.qty,
        line.unitPrice,
        line.costPrice,
        Math.round(line.qty * line.unitPrice),
        index + 1,
      );

      recordMovement(db, {
        itemId: line.itemId,
        type: 'sale',
        qtyDelta: -line.qty,
        refType: 'sale',
        refId: saleId,
        userId: actor.id,
      });
    });

    let customerBalance: number | null = customer?.balance ?? null;

    if (settlement.credit > 0 && input.customerId) {
      const ledger = appendLedgerEntry(db, {
        customerId: input.customerId,
        type: 'credit_sale',
        amount: settlement.credit,
        refType: 'sale',
        refId: saleId,
        refLabel: invoiceNo,
        userId: actor.id,
      });
      customerBalance = ledger.balanceAfter;
    }

    // Price overrides are audited individually: "why was this sold at 180 when
    // it is priced at 250" is a question that gets asked weeks later.
    for (const line of overrides) {
      writeAudit(db, {
        userId: actor.id,
        action: 'sale.price_override',
        entity: 'sale',
        entityId: saleId,
        summary: `${line.itemName} sold at ${formatPKR(line.unitPrice)} on ${invoiceNo}`,
        before: { listPrice: defaultPriceFor(db, line.itemId), minPrice: line.minPrice },
        after: { chargedPrice: line.unitPrice },
      });
    }

    writeAudit(db, {
      userId: actor.id,
      action: 'sale.create',
      entity: 'sale',
      entityId: saleId,
      summary:
        `Bill ${invoiceNo} for ${formatPKR(totals.total)}` +
        (customer ? ` to ${customer.name}` : '') +
        (settlement.credit > 0 ? ` (${formatPKR(settlement.credit)} on udhaar)` : ''),
      after: {
        invoiceNo,
        total: totals.total,
        paid: settlement.paid,
        credit: settlement.credit,
        method: input.paymentMethod,
        lines: draft.length,
      },
    });

    return { customerBalance };
  })();

  const sale = findSaleById(db, saleId);
  if (!sale) throw new AppError('internal', 'The bill was not saved. Try again.');

  return { sale, change: settlement.change, customerBalance: result.customerBalance };
}

/**
 * Cancel a bill.
 *
 * Nothing is deleted. The bill is marked voided, the stock goes back, and any
 * amount that was on udhaar is reversed with its own ledger entry — so the
 * customer's history shows the charge and the reversal, rather than a debt that
 * quietly vanished.
 */
export function voidSale(
  db: BetterSqlite3.Database,
  saleId: string,
  reason: string,
  userId: string,
): SaleRecord {
  const sale = findSaleById(db, saleId);
  if (!sale) throw new AppError('not_found', 'That bill no longer exists.');
  if (sale.status === 'voided') throw new AppError('already_voided', 'That bill is already cancelled.');
  if (!reason.trim()) throw new AppError('reason_required', 'Say why this bill is being cancelled.');
  if (sale.returnedTotal > 0) {
    throw new AppError(
      'has_returns',
      'This bill already has a return against it. Cancel the return first.',
    );
  }

  db.transaction(() => {
    db.prepare(`UPDATE sales SET status = 'voided', note = ?, updated_at = ? WHERE id = ?`).run(
      [sale.note, `Cancelled: ${reason.trim()}`].filter(Boolean).join(' — '),
      nowIso(),
      saleId,
    );

    for (const line of sale.lines) {
      recordMovement(db, {
        itemId: line.itemId,
        type: 'return',
        qtyDelta: line.qty,
        reason: 'Bill cancelled',
        refType: 'sale_void',
        refId: saleId,
        userId,
      });
    }

    if (sale.credit > 0 && sale.customerId) {
      appendLedgerEntry(db, {
        customerId: sale.customerId,
        type: 'adjustment',
        amount: -sale.credit,
        refType: 'sale_void',
        refId: saleId,
        refLabel: sale.invoiceNo,
        note: `Bill ${sale.invoiceNo} cancelled`,
        userId,
      });
    }

    writeAudit(db, {
      userId,
      action: 'sale.void',
      entity: 'sale',
      entityId: saleId,
      summary: `Cancelled ${sale.invoiceNo} (${formatPKR(sale.total)}): ${reason.trim()}`,
      before: sale,
      after: { reason: reason.trim() },
    });
  })();

  const updated = findSaleById(db, saleId);
  if (!updated) throw new AppError('internal', 'The bill could not be updated.');
  return updated;
}

function defaultPriceFor(db: BetterSqlite3.Database, itemId: string): number {
  const row = db.prepare(`SELECT sale_price FROM items WHERE id = ?`).get(itemId) as
    | { sale_price: number }
    | undefined;
  return row?.sale_price ?? 0;
}
