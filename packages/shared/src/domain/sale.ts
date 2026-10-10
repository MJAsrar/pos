/**
 * Bill arithmetic. Shared by the counter and, later, the website, so the owner's
 * numbers can never disagree with the cashier's.
 */

import { lineTotal, roundToRupee, sumPaisa, type Paisa } from '../money.js';
import { allowsFractionalQty, type PaymentMethod, type Unit } from '../types/index.js';

/** A line in the cart, before the bill is saved. */
export interface DraftLine {
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: Unit;
  qty: number;
  unitPrice: Paisa;
  /** Cost at this moment, snapshotted onto the saved line. */
  costPrice: Paisa;
  /** Bargaining floor for this item, if the admin set one. */
  minPrice: Paisa | null;
  /** Stock on hand when the line was added, for the negative-stock check. */
  qtyOnHand: number;
}

export interface SaleTotals {
  subtotal: Paisa;
  discount: Paisa;
  /** Adjustment applied to reach a whole-rupee total. Kept so reports reconcile. */
  rounding: Paisa;
  total: Paisa;
  costTotal: Paisa;
}

export function draftLineTotal(line: Pick<DraftLine, 'qty' | 'unitPrice'>): Paisa {
  return lineTotal(line.qty, line.unitPrice);
}

/**
 * Totals for a bill.
 *
 * Discount is clamped into [0, subtotal] rather than trusted — a negative
 * discount is a free money bug and a discount above the subtotal is a negative bill.
 */
export function computeSaleTotals(lines: readonly DraftLine[], discount: Paisa = 0): SaleTotals {
  const subtotal = sumPaisa(lines.map(draftLineTotal));
  const clampedDiscount = Math.min(Math.max(Math.round(discount), 0), subtotal);
  const beforeRounding = subtotal - clampedDiscount;
  const total = roundToRupee(beforeRounding);
  const costTotal = sumPaisa(lines.map((line) => lineTotal(line.qty, line.costPrice)));

  return {
    subtotal,
    discount: clampedDiscount,
    rounding: total - beforeRounding,
    total,
    costTotal,
  };
}

/** Profit on a bill: what the customer pays, minus what the goods cost the shop. */
export function saleProfit(totals: Pick<SaleTotals, 'total' | 'costTotal'>): Paisa {
  return totals.total - totals.costTotal;
}

export interface Settlement {
  /** Amount applied to this bill. Never more than the total. */
  paid: Paisa;
  /** Cash handed back to the customer. */
  change: Paisa;
  /** Remainder booked to the customer's udhaar. */
  credit: Paisa;
}

/**
 * Work out what actually happens when the customer hands over `tendered`.
 *
 * Paying less than the total is normal here — the remainder goes on the khata.
 * Paying more only makes sense for cash, where the difference is change.
 */
export function settleSale(total: Paisa, tendered: Paisa, method: PaymentMethod): Settlement {
  if (method === 'credit') {
    return { paid: 0, change: 0, credit: total };
  }
  const received = Math.max(0, Math.round(tendered));
  const paid = Math.min(received, total);
  return {
    paid,
    change: method === 'cash' ? received - paid : 0,
    credit: total - paid,
  };
}

export type SaleIssueCode =
  | 'empty'
  | 'invalid_qty'
  | 'fractional_qty'
  | 'negative_price'
  | 'below_min_price'
  | 'insufficient_stock'
  | 'credit_without_customer'
  | 'overpaid_non_cash';

export interface SaleIssue {
  code: SaleIssueCode;
  message: string;
  /** Index into `lines` when the problem is with one line. */
  lineIndex?: number;
  /** True when the admin's settings turn this into a hard stop. */
  blocking: boolean;
}

export interface ValidateSaleInput {
  lines: readonly DraftLine[];
  discount?: Paisa;
  customerId?: string | null;
  paymentMethod: PaymentMethod;
  tendered?: Paisa;
  enforceMinPrice: boolean;
  blockNegativeStock: boolean;
  /** Whether the current user may sell below the floor price. */
  canOverrideMinPrice: boolean;
}

/**
 * Check a bill before it is saved.
 *
 * Returns every problem rather than the first, so the cashier sees one complete
 * list instead of fixing issues one reload at a time. `blocking` separates a hard
 * stop from a warning the cashier may confirm past.
 */
export function validateSale(input: ValidateSaleInput): SaleIssue[] {
  const issues: SaleIssue[] = [];
  const { lines } = input;

  if (lines.length === 0) {
    issues.push({ code: 'empty', message: 'Add at least one item to the bill.', blocking: true });
  }

  lines.forEach((line, lineIndex) => {
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      issues.push({
        code: 'invalid_qty',
        message: `${line.itemName}: quantity must be more than zero.`,
        lineIndex,
        blocking: true,
      });
    } else if (!allowsFractionalQty(line.unit) && !Number.isInteger(line.qty)) {
      issues.push({
        code: 'fractional_qty',
        message: `${line.itemName} is sold in whole ${line.unit}, not fractions.`,
        lineIndex,
        blocking: true,
      });
    }

    if (line.unitPrice < 0) {
      issues.push({
        code: 'negative_price',
        message: `${line.itemName}: price cannot be negative.`,
        lineIndex,
        blocking: true,
      });
    } else if (line.minPrice !== null && line.unitPrice < line.minPrice) {
      issues.push({
        code: 'below_min_price',
        message: `${line.itemName} is priced below its minimum.`,
        lineIndex,
        blocking: input.enforceMinPrice && !input.canOverrideMinPrice,
      });
    }

    if (line.qty > line.qtyOnHand) {
      issues.push({
        code: 'insufficient_stock',
        message: `${line.itemName}: only ${line.qtyOnHand} in stock.`,
        lineIndex,
        blocking: input.blockNegativeStock,
      });
    }
  });

  const totals = computeSaleTotals(lines, input.discount ?? 0);
  const settlement = settleSale(totals.total, input.tendered ?? 0, input.paymentMethod);

  if (settlement.credit > 0 && !input.customerId) {
    issues.push({
      code: 'credit_without_customer',
      message: 'Choose a customer before putting an amount on udhaar.',
      blocking: true,
    });
  }

  if (
    input.paymentMethod !== 'cash' &&
    input.paymentMethod !== 'credit' &&
    (input.tendered ?? 0) > totals.total
  ) {
    issues.push({
      code: 'overpaid_non_cash',
      message: 'Amount received is more than the bill total.',
      blocking: true,
    });
  }

  return issues;
}

export function hasBlockingIssue(issues: readonly SaleIssue[]): boolean {
  return issues.some((issue) => issue.blocking);
}

/** Build the next invoice number, e.g. `AH-00042`. */
export function formatInvoiceNo(prefix: string, sequence: number, width = 5): string {
  return `${normalisePrefix(prefix)}-${String(sequence).padStart(width, '0')}`;
}

/** The prefix as it appears in a bill number, however it was typed. */
export function normalisePrefix(prefix: string): string {
  return prefix.trim().replace(/[^A-Za-z0-9-]/g, '').toUpperCase() || 'INV';
}

/**
 * The sequence number out of a bill number, or null if it is not from this
 * series.
 *
 * Needed because the invoice sequence is per-computer and never synced — it
 * has to keep working with no connection, so it cannot ask the server for the
 * next number. A computer that has just joined an existing shop therefore
 * holds bills it did not mint, and its own counter would otherwise start again
 * at one and claim a number the shop has already used.
 *
 * Bills under a different prefix are not part of this series and return null:
 * if the shop changes its prefix, the old numbers must not drag the new series
 * forward past them.
 */
export function parseInvoiceNo(prefix: string, invoiceNo: string): number | null {
  const expected = normalisePrefix(prefix);
  const separator = invoiceNo.lastIndexOf('-');
  if (separator <= 0) return null;

  if (invoiceNo.slice(0, separator).toUpperCase() !== expected) return null;

  const digits = invoiceNo.slice(separator + 1);
  if (!/^\d+$/.test(digits)) return null;

  const sequence = Number(digits);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
