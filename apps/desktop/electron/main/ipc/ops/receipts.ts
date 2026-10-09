import { z } from 'zod';
import { defineOp } from '../router.js';
import { openPdf, renderCustomerStatement, renderSaleReceipt } from '../../services/pdfService.js';

/**
 * Receipts and statements as PDFs.
 *
 * `open` is on by default because the point of generating one is to attach it
 * in WhatsApp, which means it has to appear on screen first.
 */
export function registerReceiptOps(): void {
  defineOp({
    op: 'receipt.sale',
    input: z.object({ saleId: z.string().min(1), open: z.boolean().optional() }),
    handler: async (input, ctx) => {
      const result = await renderSaleReceipt(ctx.db, input.saleId);
      if (input.open !== false) await openPdf(result.path);
      return result;
    },
  });

  defineOp({
    op: 'receipt.statement',
    input: z.object({ customerId: z.string().min(1), open: z.boolean().optional() }),
    handler: async (input, ctx) => {
      const result = await renderCustomerStatement(ctx.db, input.customerId);
      if (input.open !== false) await openPdf(result.path);
      return result;
    },
  });
}
