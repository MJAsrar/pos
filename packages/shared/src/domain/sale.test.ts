import { describe, expect, it } from 'vitest';
import {
  computeSaleTotals,
  formatInvoiceNo,
  hasBlockingIssue,
  saleProfit,
  settleSale,
  validateSale,
  type DraftLine,
} from './sale.js';

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    itemId: 'i1',
    itemCode: '101',
    itemName: 'USB Cable',
    unit: 'pcs',
    qty: 1,
    unitPrice: 25000,
    costPrice: 18000,
    minPrice: null,
    qtyOnHand: 10,
    ...over,
  };
}

describe('computeSaleTotals', () => {
  it('sums lines and rounds the total to the rupee', () => {
    const totals = computeSaleTotals([
      line({ qty: 2, unitPrice: 25000 }),
      line({ qty: 2.5, unitPrice: 3730, unit: 'mtr' }),
    ]);
    expect(totals.subtotal).toBe(50000 + 9325);
    expect(totals.total).toBe(59300);
    expect(totals.rounding).toBe(-25);
    expect(totals.subtotal + totals.rounding).toBe(totals.total);
  });

  it('clamps a discount into range rather than trusting it', () => {
    expect(computeSaleTotals([line()], -5000).discount).toBe(0);
    expect(computeSaleTotals([line()], 999999).discount).toBe(25000);
  });

  it('reconciles subtotal, discount and rounding against the total', () => {
    const totals = computeSaleTotals([line({ qty: 3, unitPrice: 33333 })], 1000);
    expect(totals.subtotal - totals.discount + totals.rounding).toBe(totals.total);
  });

  it('totals an empty cart to zero', () => {
    const totals = computeSaleTotals([]);
    expect(totals).toMatchObject({ subtotal: 0, total: 0, costTotal: 0, rounding: 0 });
  });

  it('snapshots cost so profit can be computed from the bill alone', () => {
    const totals = computeSaleTotals([line({ qty: 2, unitPrice: 25000, costPrice: 18000 })]);
    expect(totals.costTotal).toBe(36000);
    expect(saleProfit(totals)).toBe(50000 - 36000);
  });

  it('counts a discount against profit', () => {
    const totals = computeSaleTotals([line({ qty: 2, unitPrice: 25000, costPrice: 18000 })], 5000);
    expect(saleProfit(totals)).toBe(45000 - 36000);
  });
});

describe('settleSale', () => {
  it('treats an exact cash payment as fully paid', () => {
    expect(settleSale(200000, 200000, 'cash')).toEqual({ paid: 200000, change: 0, credit: 0 });
  });

  it('gives change without ever recording more than the bill total', () => {
    expect(settleSale(180000, 200000, 'cash')).toEqual({ paid: 180000, change: 20000, credit: 0 });
  });

  it('books the shortfall to udhaar, which is the part-payment case', () => {
    // Rs 2,000 bill, Rs 1,500 cash, Rs 500 on the khata
    expect(settleSale(200000, 150000, 'cash')).toEqual({ paid: 150000, change: 0, credit: 50000 });
  });

  it('puts the whole bill on udhaar for a credit sale', () => {
    expect(settleSale(200000, 0, 'credit')).toEqual({ paid: 0, change: 0, credit: 200000 });
  });

  it('ignores a tendered amount on a credit sale', () => {
    expect(settleSale(200000, 999999, 'credit')).toEqual({ paid: 0, change: 0, credit: 200000 });
  });

  it('never returns change for wallet or bank transfers', () => {
    expect(settleSale(180000, 200000, 'wallet').change).toBe(0);
    expect(settleSale(180000, 200000, 'bank').change).toBe(0);
  });

  it('treats a negative tendered amount as nothing paid', () => {
    expect(settleSale(200000, -500, 'cash')).toEqual({ paid: 0, change: 0, credit: 200000 });
  });
});

const baseValidation = {
  enforceMinPrice: true,
  blockNegativeStock: false,
  canOverrideMinPrice: false,
  paymentMethod: 'cash' as const,
};

describe('validateSale', () => {
  it('passes a clean cash sale', () => {
    const issues = validateSale({ ...baseValidation, lines: [line()], tendered: 25000 });
    expect(issues).toEqual([]);
  });

  it('blocks an empty bill', () => {
    const issues = validateSale({ ...baseValidation, lines: [], tendered: 0 });
    expect(issues.map((i) => i.code)).toContain('empty');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks fractional quantities of a whole-unit item', () => {
    const issues = validateSale({
      ...baseValidation,
      lines: [line({ qty: 1.5, unit: 'pcs' })],
      tendered: 99999,
    });
    expect(issues.map((i) => i.code)).toContain('fractional_qty');
  });

  it('allows fractional quantities of wire sold by the metre', () => {
    const issues = validateSale({
      ...baseValidation,
      lines: [line({ qty: 2.5, unit: 'mtr' })],
      tendered: 99999,
    });
    expect(issues).toEqual([]);
  });

  it('blocks a below-floor price when the setting is enforced', () => {
    const issues = validateSale({
      ...baseValidation,
      lines: [line({ unitPrice: 15000, minPrice: 20000 })],
      tendered: 99999,
    });
    expect(issues.find((i) => i.code === 'below_min_price')?.blocking).toBe(true);
  });

  it('lets an admin override the floor price, keeping it as a warning', () => {
    const issues = validateSale({
      ...baseValidation,
      canOverrideMinPrice: true,
      lines: [line({ unitPrice: 15000, minPrice: 20000 })],
      tendered: 99999,
    });
    expect(issues.find((i) => i.code === 'below_min_price')?.blocking).toBe(false);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('warns about overselling but only blocks when configured to', () => {
    const over = { ...baseValidation, lines: [line({ qty: 20, qtyOnHand: 5 })], tendered: 999999 };
    expect(validateSale(over).find((i) => i.code === 'insufficient_stock')?.blocking).toBe(false);
    expect(
      validateSale({ ...over, blockNegativeStock: true }).find(
        (i) => i.code === 'insufficient_stock',
      )?.blocking,
    ).toBe(true);
  });

  it('refuses to leave a balance owing with no customer attached', () => {
    const issues = validateSale({
      ...baseValidation,
      lines: [line({ unitPrice: 200000 })],
      tendered: 150000,
    });
    expect(issues.map((i) => i.code)).toContain('credit_without_customer');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('accepts a part payment once a customer is attached', () => {
    const issues = validateSale({
      ...baseValidation,
      lines: [line({ unitPrice: 200000 })],
      tendered: 150000,
      customerId: 'c1',
    });
    expect(issues).toEqual([]);
  });

  it('rejects overpayment by wallet or bank, where change makes no sense', () => {
    const issues = validateSale({
      ...baseValidation,
      paymentMethod: 'bank',
      lines: [line({ unitPrice: 200000 })],
      tendered: 250000,
      customerId: 'c1',
    });
    expect(issues.map((i) => i.code)).toContain('overpaid_non_cash');
  });

  it('reports every problem at once, not just the first', () => {
    const issues = validateSale({
      ...baseValidation,
      lines: [line({ qty: 0 }), line({ unitPrice: -100 })],
      tendered: 0,
    });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatInvoiceNo', () => {
  it('pads the sequence and upper-cases the prefix', () => {
    expect(formatInvoiceNo('AH', 42)).toBe('AH-00042');
    expect(formatInvoiceNo('ah', 1)).toBe('AH-00001');
    expect(formatInvoiceNo('AH', 123456)).toBe('AH-123456');
  });

  it('falls back when the prefix is unusable', () => {
    expect(formatInvoiceNo('  ', 7)).toBe('INV-00007');
    expect(formatInvoiceNo('A/H #', 7)).toBe('AH-00007');
  });
});
