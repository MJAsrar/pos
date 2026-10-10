import { z } from 'zod';
import { can, today } from '@pos/shared';
import { defineOp } from '../router.js';
import {
  COMMON_EXPENSE_CATEGORIES,
  listExpenses,
  removeExpense,
  saveExpense,
} from '../../services/expenseService.js';
import {
  bestSellers,
  customerDues,
  deadStock,
  lowStock,
  salesSummary,
  stockValue,
} from '../../services/reportService.js';
import { exportSalesReport } from '../../services/exportService.js';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.');
const rangeSchema = z.object({ from: localDate, to: localDate });

/**
 * Reports and expenses.
 *
 * Everything that reveals margin is gated behind `report.view_profit`, and the
 * profit fields are removed here rather than hidden by the UI — a staff account
 * should not be able to read the shop's margin out of an IPC response.
 */
export function registerReportOps(): void {
  /**
   * Save the report as a file the owner can attach to something.
   *
   * Profit is left out of the file entirely when the person saving it is not
   * allowed to see it, rather than blanked: a file is the easiest thing in the
   * world to pass on, and empty columns would still show the shape of it.
   */
  defineOp({
    op: 'report.export',
    permission: 'report.view',
    input: rangeSchema,
    handler: (input, ctx) =>
      exportSalesReport(ctx.db, input, {
        includeProfit: can(ctx.user, 'report.view_profit'),
      }),
  });

  defineOp({
    op: 'report.sales',
    permission: 'report.view',
    input: rangeSchema,
    handler: (input, ctx) => {
      const summary = salesSummary(ctx.db, input);
      if (can(ctx.user, 'report.view_profit')) return summary;

      return {
        ...summary,
        costOfGoods: null,
        grossProfit: null,
        expenses: null,
        netProfit: null,
        expenseBreakdown: [],
        byDay: summary.byDay.map(({ grossProfit: _hidden, ...day }) => ({ ...day, grossProfit: null })),
      };
    },
  });

  defineOp({
    op: 'report.stockValue',
    permission: 'report.view',
    input: z.void().optional(),
    handler: (_input, ctx) => {
      const value = stockValue(ctx.db);
      if (can(ctx.user, 'item.view_cost')) return value;

      return {
        rows: value.rows.map((row) => ({ ...row, costPrice: null, stockCost: null })),
        totalCost: null,
        totalRetail: value.totalRetail,
      };
    },
  });

  defineOp({
    op: 'report.lowStock',
    permission: 'report.view',
    input: z.void().optional(),
    handler: (_input, ctx) => lowStock(ctx.db),
  });

  defineOp({
    op: 'report.bestSellers',
    permission: 'report.view',
    input: rangeSchema.extend({ limit: z.number().int().min(1).max(100).optional() }),
    handler: (input, ctx) => {
      const rows = bestSellers(ctx.db, input, input.limit ?? 25);
      if (can(ctx.user, 'report.view_profit')) return rows;
      return rows.map((row) => ({ ...row, profit: null }));
    },
  });

  defineOp({
    op: 'report.deadStock',
    permission: 'report.view',
    input: z.object({ days: z.number().int().min(7).max(730).optional() }).optional(),
    handler: (input, ctx) => {
      const rows = deadStock(ctx.db, input?.days ?? 90);
      if (can(ctx.user, 'item.view_cost')) return rows;
      return rows.map((row) => ({ ...row, stockCost: null }));
    },
  });

  defineOp({
    op: 'report.dues',
    permission: 'report.view',
    input: z.void().optional(),
    handler: (_input, ctx) => customerDues(ctx.db),
  });

  // --- Expenses ----------------------------------------------------------

  defineOp({
    op: 'expense.categories',
    input: z.void().optional(),
    handler: () => [...COMMON_EXPENSE_CATEGORIES],
  });

  defineOp({
    op: 'expense.list',
    permission: 'expense.manage',
    input: z
      .object({
        from: localDate.optional(),
        to: localDate.optional(),
        category: z.string().max(60).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .optional(),
    handler: (input, ctx) =>
      listExpenses(ctx.db, {
        ...(input?.from ? { from: input.from } : {}),
        ...(input?.to ? { to: input.to } : {}),
        ...(input?.category ? { category: input.category } : {}),
        ...(input?.limit ? { limit: input.limit } : {}),
      }),
  });

  defineOp({
    op: 'expense.save',
    permission: 'expense.manage',
    input: z.object({
      id: z.string().min(1).optional(),
      category: z.string().min(2).max(60),
      description: z.string().max(200).nullable().optional(),
      amount: z.number().int().positive(),
      spentAt: localDate.optional(),
    }),
    handler: (input, ctx) =>
      saveExpense(ctx.db, { ...input, spentAt: input.spentAt ?? today() }, ctx.user.id),
  });

  defineOp({
    op: 'expense.remove',
    permission: 'expense.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      removeExpense(ctx.db, input.id, ctx.user.id);
      return { ok: true };
    },
  });
}
