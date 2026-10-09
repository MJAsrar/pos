import { z } from 'zod';
import { UNITS, can, type Unit } from '@pos/shared';
import { defineOp } from '../router.js';
import { findItemById, listItems, suggestNextCode, type ItemRecord } from '../../db/repos/itemRepo.js';
import {
  createCategory,
  createItem,
  listCategories,
  removeCategory,
  removeItem,
  renameCategory,
  saveItem,
} from '../../services/itemService.js';
import {
  adjustStock,
  applyStockCount,
  itemHistory,
  stockIn,
} from '../../services/stockService.js';
import { applyItemImport, parseItemCsv } from '../../services/importService.js';
import {
  chooseImage,
  clearItemPhoto,
  readPhoto,
  setItemPhoto,
} from '../../services/imageService.js';
import type { SessionUser } from '../../session.js';

const unitSchema = z.enum(UNITS as unknown as [Unit, ...Unit[]]);
const paisa = z.number().int().min(0);

const itemFields = {
  code: z.string().min(1).max(24),
  name: z.string().min(2).max(120),
  categoryId: z.string().nullable(),
  unit: unitSchema,
  costPrice: paisa,
  salePrice: paisa,
  minPrice: paisa.nullable(),
  lowStockLevel: z.number().min(0),
  photoPath: z.string().nullable(),
};

/**
 * What the renderer is allowed to know about an item.
 *
 * Cost price and margin are stripped for anyone without `item.view_cost`. This
 * happens here rather than in the UI, because a value that never leaves the main
 * process cannot be read out of the page by a curious member of staff.
 */
export interface ItemView extends Omit<ItemRecord, 'costPrice'> {
  costPrice: number | null;
}

function view(item: ItemRecord, user: SessionUser): ItemView {
  const showCost = can(user, 'item.view_cost');
  return { ...item, costPrice: showCost ? item.costPrice : null };
}

export function registerItemOps(): void {
  defineOp({
    op: 'item.list',
    input: z.object({ includeInactive: z.boolean().optional() }).optional(),
    handler: (input, ctx) =>
      listItems(ctx.db, { includeInactive: input?.includeInactive ?? false }).map((item) =>
        view(item, ctx.user),
      ),
  });

  defineOp({
    op: 'item.get',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      const item = findItemById(ctx.db, input.id);
      return item ? view(item, ctx.user) : null;
    },
  });

  defineOp({
    op: 'item.create',
    permission: 'item.manage',
    input: z.object({ ...itemFields, openingQty: z.number().min(0).optional() }),
    handler: (input, ctx) => view(createItem(ctx.db, input, ctx.user.id), ctx.user),
  });

  defineOp({
    op: 'item.save',
    permission: 'item.manage',
    input: z.object({ ...itemFields, id: z.string().min(1), isActive: z.boolean().optional() }),
    handler: (input, ctx) => view(saveItem(ctx.db, input, ctx.user.id), ctx.user),
  });

  defineOp({
    op: 'item.remove',
    permission: 'item.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => removeItem(ctx.db, input.id, ctx.user.id),
  });

  defineOp({
    op: 'item.nextCode',
    permission: 'item.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => ({ code: suggestNextCode(ctx.db) }),
  });

  defineOp({
    op: 'item.history',
    input: z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(500).optional() }),
    handler: (input, ctx) => {
      const rows = itemHistory(ctx.db, input.id, input.limit ?? 200);
      if (can(ctx.user, 'item.view_cost')) return rows;
      return rows.map((row) => ({ ...row, unitCost: null }));
    },
  });

  // --- Pictures ----------------------------------------------------------

  /** The item's picture as a data URL, or null. Any signed-in user may see it. */
  defineOp({
    op: 'item.photo',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      const item = findItemById(ctx.db, input.id);
      return { dataUrl: readPhoto(item?.photoPath ?? null) };
    },
  });

  defineOp({
    op: 'item.setPhoto',
    permission: 'item.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: async (input, ctx) => {
      const picked = await chooseImage('Choose a picture for this item');
      if (!picked) return { cancelled: true as const };
      const { photoPath } = setItemPhoto(ctx.db, input.id, picked, ctx.user.id);
      return { cancelled: false as const, dataUrl: readPhoto(photoPath) };
    },
  });

  defineOp({
    op: 'item.clearPhoto',
    permission: 'item.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => clearItemPhoto(ctx.db, input.id, ctx.user.id),
  });

  // --- Stock -------------------------------------------------------------

  defineOp({
    op: 'stock.in',
    permission: 'stock.manage',
    input: z.object({
      itemId: z.string().min(1),
      qty: z.number().positive(),
      unitCost: paisa.nullable().optional(),
      supplierName: z.string().max(80).nullable().optional(),
      note: z.string().max(200).nullable().optional(),
    }),
    handler: (input, ctx) => stockIn(ctx.db, input, ctx.user.id),
  });

  defineOp({
    op: 'stock.adjust',
    permission: 'stock.manage',
    input: z.object({
      itemId: z.string().min(1),
      countedQty: z.number().min(0),
      reason: z.enum(['damaged', 'lost', 'correction', 'other']),
      note: z.string().max(200).nullable().optional(),
    }),
    handler: (input, ctx) => adjustStock(ctx.db, input, ctx.user.id),
  });

  /**
   * A whole stock-take at once.
   *
   * Same permission as any other stock change, and the same movement rows come
   * out of it — this is a faster way to enter them, not a different kind of
   * record.
   */
  defineOp({
    op: 'stock.count',
    permission: 'stock.manage',
    input: z.object({
      counts: z
        .array(z.object({ itemId: z.string().min(1), countedQty: z.number().min(0) }))
        .min(1, 'No counts were entered.')
        .max(5000),
    }),
    handler: (input, ctx) => applyStockCount(ctx.db, input.counts, ctx.user.id),
  });

  // --- Bringing a list in from Excel -------------------------------------

  defineOp({
    op: 'item.previewImport',
    permission: 'item.manage',
    input: z.object({ csv: z.string().min(1).max(5_000_000) }),
    handler: (input, ctx) => parseItemCsv(ctx.db, input.csv),
  });

  defineOp({
    op: 'item.applyImport',
    permission: 'item.manage',
    input: z.object({
      rows: z.array(
        z.object({
          line: z.number().int(),
          code: z.string().min(1).max(24),
          name: z.string().min(1).max(120),
          unit: unitSchema,
          costPrice: paisa,
          salePrice: paisa,
          openingQty: z.number().min(0),
          lowStockLevel: z.number().min(0),
          categoryName: z.string().max(60),
          categoryId: z.string().nullable(),
          existingId: z.string().nullable(),
        }),
      ).min(1),
    }),
    handler: (input, ctx) => applyItemImport(ctx.db, input.rows, ctx.user.id),
  });

  // --- Categories --------------------------------------------------------

  defineOp({
    op: 'category.list',
    input: z.void().optional(),
    handler: (_input, ctx) => listCategories(ctx.db),
  });

  defineOp({
    op: 'category.create',
    permission: 'item.manage',
    input: z.object({ name: z.string().min(2).max(60) }),
    handler: (input, ctx) => createCategory(ctx.db, input.name, ctx.user.id),
  });

  defineOp({
    op: 'category.rename',
    permission: 'item.manage',
    input: z.object({ id: z.string().min(1), name: z.string().min(2).max(60) }),
    handler: (input, ctx) => {
      renameCategory(ctx.db, input.id, input.name, ctx.user.id);
      return { ok: true };
    },
  });

  defineOp({
    op: 'category.remove',
    permission: 'item.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      removeCategory(ctx.db, input.id, ctx.user.id);
      return { ok: true };
    },
  });
}
