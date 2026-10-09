import { z } from 'zod';
import { can, rangeToTimestamps } from '@pos/shared';
import { AppError, defineOp } from '../router.js';
import {
  findSaleById,
  findSaleByInvoiceNo,
  listSales,
  recentSales,
  type SaleRecord,
  type SaleSummary,
} from '../../db/repos/saleRepo.js';
import { createSale, voidSale } from '../../services/saleService.js';
import { createReturn, listReturnsForSale } from '../../services/returnService.js';
import {
  discardHeldSale,
  holdSale,
  listHeldSales,
  recallHeldSale,
} from '../../services/heldSaleService.js';
import type { SessionUser } from '../../session.js';

const paisa = z.number().int();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.');

/**
 * Bills: making them, reading them back, cancelling them, and taking returns.
 *
 * Cost and profit are stripped from anything returned to a cashier who may not
 * see them, the same way item cost is. A staff account can reprint a customer's
 * bill without learning the shop's margin on it.
 */

type SaleView = Omit<SaleRecord, 'costTotal' | 'lines'> & {
  costTotal: number | null;
  profit: number | null;
  lines: Array<Omit<SaleRecord['lines'][number], 'costPrice'> & { costPrice: number | null }>;
};

function viewSale(sale: SaleRecord, user: SessionUser): SaleView {
  const showProfit = can(user, 'report.view_profit');
  return {
    ...sale,
    costTotal: showProfit ? sale.costTotal : null,
    profit: showProfit ? sale.total - sale.costTotal : null,
    lines: sale.lines.map((line) => ({
      ...line,
      costPrice: showProfit ? line.costPrice : null,
    })),
  };
}

function viewSummary(sale: SaleSummary, user: SessionUser) {
  const showProfit = can(user, 'report.view_profit');
  return {
    ...sale,
    costTotal: showProfit ? sale.costTotal : null,
    profit: showProfit ? sale.total - sale.costTotal : null,
  };
}

export function registerSaleOps(): void {
  defineOp({
    op: 'sale.create',
    permission: 'sale.create',
    input: z.object({
      lines: z
        .array(
          z.object({
            itemId: z.string().min(1),
            qty: z.number().positive(),
            unitPrice: paisa.min(0).optional(),
          }),
        )
        .min(1, 'Add at least one item to the bill.'),
      customerId: z.string().min(1).nullable().optional(),
      discount: paisa.min(0).optional(),
      paymentMethod: z.enum(['cash', 'wallet', 'bank', 'credit']),
      tendered: paisa.optional(),
      note: z.string().max(300).nullable().optional(),
    }),
    handler: (input, ctx) => {
      const result = createSale(ctx.db, input, {
        id: ctx.user.id,
        canEditPrice: can(ctx.user, 'sale.edit_price'),
        canDiscount: can(ctx.user, 'sale.discount'),
        canSellOnCredit: can(ctx.user, 'sale.credit'),
      });
      return {
        sale: viewSale(result.sale, ctx.user),
        change: result.change,
        customerBalance: result.customerBalance,
      };
    },
  });

  defineOp({
    op: 'sale.get',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      const sale = findSaleById(ctx.db, input.id);
      if (!sale) return null;
      assertMayView(sale, ctx.user);
      return { sale: viewSale(sale, ctx.user), returns: listReturnsForSale(ctx.db, sale.id) };
    },
  });

  defineOp({
    op: 'sale.byInvoiceNo',
    input: z.object({ invoiceNo: z.string().min(1) }),
    handler: (input, ctx) => {
      const sale = findSaleByInvoiceNo(ctx.db, input.invoiceNo);
      if (!sale) return null;
      assertMayView(sale, ctx.user);
      return viewSale(sale, ctx.user);
    },
  });

  defineOp({
    op: 'sale.list',
    input: z.object({
      from: localDate.optional(),
      to: localDate.optional(),
      customerId: z.string().min(1).optional(),
      userId: z.string().min(1).optional(),
      status: z.enum(['active', 'voided']).optional(),
      paymentMethod: z.enum(['cash', 'wallet', 'bank', 'credit']).optional(),
      search: z.string().max(80).optional(),
      creditOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    handler: (input, ctx) => {
      const range =
        input.from && input.to ? rangeToTimestamps({ from: input.from, to: input.to }) : null;

      // Without `sale.view_all`, a cashier sees only their own bills.
      const userId = can(ctx.user, 'sale.view_all') ? input.userId : ctx.user.id;

      return listSales(ctx.db, {
        ...(range ? { start: range.start, end: range.end } : {}),
        ...(userId ? { userId } : {}),
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
        ...(input.search ? { search: input.search } : {}),
        ...(input.creditOnly ? { creditOnly: true } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.offset ? { offset: input.offset } : {}),
      }).map((sale) => viewSummary(sale, ctx.user));
    },
  });

  defineOp({
    op: 'sale.recent',
    input: z.object({ limit: z.number().int().min(1).max(20).optional() }).optional(),
    handler: (input, ctx) => {
      const sales = can(ctx.user, 'sale.view_all')
        ? recentSales(ctx.db, input?.limit ?? 8)
        : listSales(ctx.db, { userId: ctx.user.id, limit: input?.limit ?? 8 });
      return sales.map((sale) => viewSummary(sale, ctx.user));
    },
  });

  // Parked bills. Scoped to the signed-in user in the service, so one cashier
  // cannot recall another's half-finished bill.
  defineOp({
    op: 'sale.hold',
    permission: 'sale.create',
    input: z.object({ label: z.string().max(60), payloadJson: z.string().max(200_000) }),
    handler: (input, ctx) => holdSale(ctx.db, input.label, input.payloadJson, ctx.user.id),
  });

  defineOp({
    op: 'sale.heldList',
    permission: 'sale.create',
    input: z.void().optional(),
    handler: (_input, ctx) => listHeldSales(ctx.db, ctx.user.id),
  });

  defineOp({
    op: 'sale.recallHeld',
    permission: 'sale.create',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => recallHeldSale(ctx.db, input.id, ctx.user.id),
  });

  defineOp({
    op: 'sale.discardHeld',
    permission: 'sale.create',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      discardHeldSale(ctx.db, input.id, ctx.user.id);
      return { ok: true };
    },
  });

  defineOp({
    op: 'sale.void',
    permission: 'sale.void',
    input: z.object({ id: z.string().min(1), reason: z.string().min(1).max(200) }),
    handler: (input, ctx) => viewSale(voidSale(ctx.db, input.id, input.reason, ctx.user.id), ctx.user),
  });

  defineOp({
    op: 'sale.return',
    permission: 'sale.return',
    input: z.object({
      saleId: z.string().min(1),
      lines: z
        .array(z.object({ saleItemId: z.string().min(1), qty: z.number().positive() }))
        .min(1, 'Choose what is being returned.'),
      refundMethod: z.enum(['cash', 'wallet', 'bank', 'credit_note']),
      reason: z.string().max(200).nullable().optional(),
    }),
    handler: (input, ctx) => createReturn(ctx.db, input, ctx.user.id),
  });
}

/** A cashier without `sale.view_all` may only open their own bills. */
function assertMayView(sale: SaleRecord, user: SessionUser): void {
  if (sale.userId !== user.id && !can(user, 'sale.view_all')) {
    throw new AppError('not_found', 'That bill could not be found.');
  }
}
