import { describe, expect, it } from 'vitest';
import { FIGURE_LABELS, figuresCsvRows, summarisePeriod, type PeriodInput } from './report.js';

/**
 * These figures are the ones the owner will compare between their phone and
 * the till, so the cases that matter are the ones where a plausible shortcut
 * gives a different answer.
 */

function day(overrides: Partial<PeriodInput> = {}): PeriodInput {
  return {
    bills: { count: 0, gross: 0, discounts: 0, total: 0, costTotal: 0, paid: 0, credit: 0 },
    returns: { total: 0, costTotal: 0 },
    expenses: 0,
    ...overrides,
  };
}

describe('summarisePeriod', () => {
  it('adds up an ordinary day', () => {
    const summary = summarisePeriod(
      day({
        bills: {
          count: 3,
          gross: 150_000,
          discounts: 5_000,
          total: 145_000,
          costTotal: 95_000,
          paid: 145_000,
          credit: 0,
        },
        expenses: 20_000,
      }),
    );

    expect(summary.netSales).toBe(145_000);
    expect(summary.grossProfit).toBe(50_000);
    expect(summary.netProfit).toBe(30_000);
    expect(summary.billCount).toBe(3);
  });

  it('takes a refund off the takings and its cost off the cost', () => {
    // The trap: subtracting the refund from takings but leaving its cost in
    // turns a neutral day into a loss. Both sides come off together.
    const summary = summarisePeriod(
      day({
        bills: { count: 2, gross: 100_000, discounts: 0, total: 100_000, costTotal: 60_000, paid: 100_000, credit: 0 },
        returns: { total: 50_000, costTotal: 30_000 },
      }),
    );

    expect(summary.netSales).toBe(50_000);
    expect(summary.costOfGoods).toBe(30_000);
    expect(summary.grossProfit).toBe(20_000);
  });

  it('reads a day where everything came back as nothing, not as a loss', () => {
    const summary = summarisePeriod(
      day({
        bills: { count: 1, gross: 80_000, discounts: 0, total: 80_000, costTotal: 55_000, paid: 80_000, credit: 0 },
        returns: { total: 80_000, costTotal: 55_000 },
      }),
    );

    expect(summary.netSales).toBe(0);
    expect(summary.grossProfit).toBe(0);
    expect(summary.netProfit).toBe(0);
  });

  it('keeps udhaar out of what was taken', () => {
    // A part-paid bill: Rs 2,000 sold, Rs 1,500 handed over.
    const summary = summarisePeriod(
      day({
        bills: {
          count: 1,
          gross: 200_000,
          discounts: 0,
          total: 200_000,
          costTotal: 140_000,
          paid: 150_000,
          credit: 50_000,
        },
      }),
    );

    // Sold is sold, whether or not it has been paid for.
    expect(summary.netSales).toBe(200_000);
    expect(summary.grossProfit).toBe(60_000);
    expect(summary.cashTaken).toBe(150_000);
    expect(summary.onCredit).toBe(50_000);
  });

  it('lets expenses turn a profitable day into a loss, and says so plainly', () => {
    const summary = summarisePeriod(
      day({
        bills: { count: 1, gross: 50_000, discounts: 0, total: 50_000, costTotal: 40_000, paid: 50_000, credit: 0 },
        expenses: 30_000,
      }),
    );

    expect(summary.grossProfit).toBe(10_000);
    expect(summary.netProfit).toBe(-20_000);
  });

  it('gives zeroes for a day with nothing in it rather than anything stranger', () => {
    const summary = summarisePeriod(day());
    for (const value of Object.values(summary)) expect(value).toBe(0);
  });

  it('stays in whole paisa, so the two ends cannot disagree by a rounding', () => {
    const summary = summarisePeriod(
      day({
        bills: { count: 7, gross: 123_457, discounts: 1, total: 123_456, costTotal: 99_999, paid: 123_456, credit: 0 },
        returns: { total: 1, costTotal: 1 },
        expenses: 3,
      }),
    );
    for (const value of Object.values(summary)) expect(Number.isInteger(value)).toBe(true);
    expect(summary.netProfit).toBe(123_455 - 99_998 - 3);
  });

  it('names every figure, so no screen has to invent a word for one', () => {
    const summary = summarisePeriod(day());
    for (const key of Object.keys(summary)) {
      expect(FIGURE_LABELS[key as keyof typeof FIGURE_LABELS]).toBeTruthy();
    }
  });

  it('calls profit what the shop calls it', () => {
    expect(FIGURE_LABELS.netSales).toBe('Takings');
    expect(FIGURE_LABELS.netProfit).toBe('Left over');
    expect(FIGURE_LABELS.onCredit).toBe('Went on udhaar');
  });
});

describe('figuresCsvRows', () => {
  const rupees = (paisa: number) => (paisa / 100).toFixed(2);

  it('writes every figure, so a saved file is not missing one', () => {
    const summary = summarisePeriod(day());
    const rows = figuresCsvRows(summary, rupees);
    // A header plus one row per figure.
    expect(rows).toHaveLength(Object.keys(summary).length + 1);
  });

  it('leads with the takings, because that is what gets looked at first', () => {
    const rows = figuresCsvRows(summarisePeriod(day()), rupees);
    expect(rows[0]).toEqual(['Figure', 'Rupees']);
    expect(rows[1]?.[0]).toBe('Takings');
  });

  it('writes money as a number a spreadsheet can add up', () => {
    const summary = summarisePeriod(
      day({ bills: { count: 1, gross: 125_000, discounts: 0, total: 125_000, costTotal: 100_000, paid: 125_000, credit: 0 } }),
    );
    const rows = figuresCsvRows(summary, rupees);
    expect(rows[1]).toEqual(['Takings', '1250.00']);
    // The bill count is a count, not money.
    expect(rows.at(-1)).toEqual(['Bills', 1]);
  });

  it('uses the words the shop uses', () => {
    const labels = figuresCsvRows(summarisePeriod(day()), rupees).map((row) => row[0]);
    expect(labels).toContain('Left over');
    expect(labels).toContain('Went on udhaar');
  });
});
