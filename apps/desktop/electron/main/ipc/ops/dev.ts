import { app } from 'electron';
import { z } from 'zod';
import { defineOp } from '../router.js';
import { saleReceiptHtml } from '../../services/pdfService.js';
import { readPhoto, setItemPhoto, setShopLogo } from '../../services/imageService.js';
import { updateSettings } from '../../services/settingsService.js';

/**
 * Development helpers.
 *
 * Registered only when the app is not packaged, so none of this can reach the
 * shop. There is deliberately no demo-data generator here: the shop's database
 * holds the shop's own records, and a fixture that invents customers and sales
 * is only ever one wrong click away from being mistaken for them.
 */
export function registerDevOps(): void {
  if (app.isPackaged) return;

  /**
   * Store a picture from a given path, skipping the file dialog.
   *
   * The real operation opens a picker, which cannot be driven from a test, so
   * this reaches the same storage code the picker feeds.
   */
  defineOp({
    op: 'dev.setItemPhoto',
    permission: 'item.manage',
    input: z.object({ id: z.string().min(1), path: z.string().min(1) }),
    handler: (input, ctx) => {
      const { photoPath } = setItemPhoto(ctx.db, input.id, input.path, ctx.user.id);
      const dataUrl = readPhoto(photoPath);
      return { photoPath, bytes: dataUrl ? Math.round((dataUrl.length * 3) / 4) : 0 };
    },
  });

  defineOp({
    op: 'dev.setShopLogo',
    permission: 'settings.manage',
    input: z.object({ path: z.string().min(1) }),
    handler: (input, ctx) => {
      // Mirror the real operation exactly: store the file *and* record it in
      // settings, or the receipt template never sees it.
      const { logoPath } = setShopLogo(input.path);
      updateSettings(ctx.db, { logoPath }, ctx.user.id);
      return { logoPath };
    },
  });

  /** The receipt as HTML, so its layout can be checked without a PDF viewer. */
  defineOp({
    op: 'dev.receiptHtml',
    permission: 'settings.manage',
    input: z.object({ saleId: z.string().min(1) }),
    handler: (input, ctx) => saleReceiptHtml(ctx.db, input.saleId),
  });
}
