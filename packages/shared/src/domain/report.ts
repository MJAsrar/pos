/**
 * The figures a shop day adds up to.
 *
 * Deliberately split out from the queries that feed it, because two different
 * places now ask the same question: the counter, against SQLite, and the
 * owner's phone, against Postgres. If each did its own arithmetic they would
 * drift, and the first anyone would know of it is the owner reading one number
 * on their phone and the cashier reading another off the till — with no way to
 * tell which is wrong.
 *
 * So the queries stay where they belong and the arithmetic lives here, once.
 *
 * Two rules run through all of it, and they are the reason this is not simply
 * a sum of bills:
 *
 * Cancelled bills are excluded, by whoever gathers the rows.
 *
 * Returns come off both the takings and the cost. A day where everything came
 * back must not read as a good day, and taking the refund off the takings while
 * leaving its cost in would turn it into a loss instead.
 */

import type { Paisa } from '../money.js';

/** What a period's bills add up to, before returns and expenses. */
export interface BillTotals {
  count: number;
  /** Before any discount. */
  gross: Paisa;
  discounts: Paisa;
  /** After discount and rounding — what the customer owed. */
  total: Paisa;
  /** Cost of what was sold, from the snapshot on each line. */
  costTotal: Paisa;
  /** Settled at the counter. */
  paid: Paisa;
  /** Left on the customer's udhaar. */
  credit: Paisa;
}

export interface ReturnTotals {
  total: Paisa;
  costTotal: Paisa;
}

export interface PeriodInput {
  bills: BillTotals;
  returns: ReturnTotals;
  expenses: Paisa;
}

export interface PeriodSummary {
  billCount: number;
  grossSales: Paisa;
  discounts: Paisa;
  /** Refunded in the period, already taken off `netSales`. */
  returns: Paisa;
  /** "Takings" — what the shop actually sold, net of refunds. */
  netSales: Paisa;
  costOfGoods: Paisa;
  /** "Profit on goods" — takings less what those goods cost. */
  grossProfit: Paisa;
  expenses: Paisa;
  /** "Left over" — profit on goods less what was spent. */
  netProfit: Paisa;
  /** "Money taken" — settled at the counter. */
  cashTaken: Paisa;
  /** "Went on udhaar". */
  onCredit: Paisa;
}

export function summarisePeriod(input: PeriodInput): PeriodSummary {
  const netSales = input.bills.total - input.returns.total;
  const costOfGoods = input.bills.costTotal - input.returns.costTotal;
  const grossProfit = netSales - costOfGoods;

  return {
    billCount: input.bills.count,
    grossSales: input.bills.gross,
    discounts: input.bills.discounts,
    returns: input.returns.total,
    netSales,
    costOfGoods,
    grossProfit,
    expenses: input.expenses,
    netProfit: grossProfit - input.expenses,
    cashTaken: input.bills.paid,
    onCredit: input.bills.credit,
  };
}

/**
 * The words the shop uses for each figure.
 *
 * Here rather than in each screen so the website and the counter cannot end up
 * calling the same number two different things. Written for a shop owner:
 * "Money kept", never "gross margin".
 */
export const FIGURE_LABELS = {
  netSales: 'Takings',
  grossProfit: 'Profit on goods',
  expenses: 'Expenses',
  netProfit: 'Left over',
  cashTaken: 'Money taken',
  onCredit: 'Went on udhaar',
  billCount: 'Bills',
  returns: 'Returns',
  discounts: 'Discounts given',
  costOfGoods: 'What the goods cost',
  grossSales: 'Before discounts',
} as const satisfies Record<keyof PeriodSummary, string>;

/**
 * The figures as rows for a spreadsheet.
 *
 * Shared for the same reason the arithmetic is: the owner may save this from
 * their phone and the cashier save it at the counter, and the two files must
 * say the same thing in the same order. Each end adds its own sections after
 * this block — the counter knows the day-by-day breakdown, the website does
 * not — but the figures themselves are written once, here.
 *
 * Money goes out as a plain number of rupees, because a column of "Rs 1,250"
 * cannot be added up by whatever the file is opened in, which is the only
 * reason to want a file.
 */
export function figuresCsvRows(
  summary: PeriodSummary,
  rupees: (paisa: Paisa) => string,
): Array<Array<string | number>> {
  return [
    ['Figure', 'Rupees'],
    [FIGURE_LABELS.netSales, rupees(summary.netSales)],
    [FIGURE_LABELS.costOfGoods, rupees(summary.costOfGoods)],
    [FIGURE_LABELS.grossProfit, rupees(summary.grossProfit)],
    [FIGURE_LABELS.expenses, rupees(summary.expenses)],
    [FIGURE_LABELS.netProfit, rupees(summary.netProfit)],
    [FIGURE_LABELS.cashTaken, rupees(summary.cashTaken)],
    [FIGURE_LABELS.onCredit, rupees(summary.onCredit)],
    [FIGURE_LABELS.returns, rupees(summary.returns)],
    [FIGURE_LABELS.discounts, rupees(summary.discounts)],
    [FIGURE_LABELS.grossSales, rupees(summary.grossSales)],
    [FIGURE_LABELS.billCount, summary.billCount],
  ];
}
