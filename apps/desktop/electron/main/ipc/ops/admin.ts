import { app, shell } from 'electron';
import { z } from 'zod';
import { GRANTABLE_PERMISSIONS, sanitizePermissions, type Permission } from '@pos/shared';
import { AppError, defineOp } from '../router.js';
import { closeDatabase } from '../../db/connection.js';
import { findUserById, listUsers, softDeleteUser, updateUser } from '../../db/repos/userRepo.js';
import {
  assertNotLastAdmin,
  changePin,
  createUser,
  toSessionUser,
} from '../../services/authService.js';
import { listAudit } from '../../services/auditService.js';
import {
  createBackup,
  inspectBackup,
  listBackups,
  restoreBackup,
} from '../../services/backupService.js';
import { chooseImage, readPhoto, setShopLogo } from '../../services/imageService.js';
import { findLedgerMismatches } from '../../services/customerService.js';
import { findStockMismatches, repairStockCache } from '../../services/stockService.js';
import { getSettings, updateSettings } from '../../services/settingsService.js';
import { backupsDir, receiptsDir } from '../../paths.js';
import { refreshSessionUser } from '../../session.js';
import { writeAudit } from '../../services/auditService.js';

const pinSchema = z.string().regex(/^\d{4}$/, 'The PIN must be exactly 4 digits.');
const permissionSchema = z.enum(GRANTABLE_PERMISSIONS as unknown as [Permission, ...Permission[]]);

/**
 * Owner-only operations: staff accounts, shop settings, backups and the audit log.
 */
export function registerAdminOps(): void {
  // --- Users -------------------------------------------------------------

  defineOp({
    op: 'user.list',
    permission: 'user.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => listUsers(ctx.db),
  });

  defineOp({
    op: 'user.grantablePermissions',
    permission: 'user.manage',
    input: z.void().optional(),
    handler: () => [...GRANTABLE_PERMISSIONS],
  });

  defineOp({
    op: 'user.create',
    permission: 'user.manage',
    input: z.object({
      fullName: z.string().min(2).max(60),
      username: z.string().min(3).max(32),
      pin: pinSchema,
      role: z.enum(['admin', 'staff']),
      permissions: z.array(permissionSchema).optional(),
    }),
    handler: (input, ctx) =>
      createUser(
        ctx.db,
        {
          username: input.username,
          fullName: input.fullName,
          pin: input.pin,
          role: input.role,
          ...(input.permissions ? { permissions: sanitizePermissions(input.permissions) } : {}),
        },
        ctx.user.id,
      ),
  });

  defineOp({
    op: 'user.save',
    permission: 'user.manage',
    input: z.object({
      id: z.string().min(1),
      fullName: z.string().min(2).max(60),
      username: z.string().min(3).max(32),
      role: z.enum(['admin', 'staff']),
      permissions: z.array(permissionSchema),
      isActive: z.boolean(),
    }),
    handler: (input, ctx) => {
      const existing = findUserById(ctx.db, input.id);
      if (!existing) throw new AppError('not_found', 'That user no longer exists.');

      // Demoting or switching off the only admin would lock the shop out of its
      // own settings, with no way back in.
      if (existing.role === 'admin' && (input.role !== 'admin' || !input.isActive)) {
        assertNotLastAdmin(ctx.db, input.id);
      }

      const permissions = input.role === 'admin' ? [] : sanitizePermissions(input.permissions);

      ctx.db.transaction(() => {
        updateUser(ctx.db, { ...input, permissions });
        writeAudit(ctx.db, {
          userId: ctx.user.id,
          action: 'user.update',
          entity: 'user',
          entityId: input.id,
          summary: `Updated account "${input.fullName}"`,
          before: existing,
          after: { role: input.role, permissions, isActive: input.isActive },
        });
      })();

      const saved = findUserById(ctx.db, input.id);
      if (!saved) throw new AppError('internal', 'The user could not be saved.');

      // Take effect immediately if the admin just changed their own account,
      // rather than at some unexplained point in the future.
      refreshSessionUser(toSessionUser(saved));
      return saved;
    },
  });

  defineOp({
    op: 'user.changePin',
    permission: 'user.manage',
    input: z.object({ id: z.string().min(1), pin: pinSchema }),
    handler: async (input, ctx) => {
      await changePin(ctx.db, input.id, input.pin, ctx.user.id);
      return { ok: true };
    },
  });

  defineOp({
    op: 'user.remove',
    permission: 'user.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      if (input.id === ctx.user.id) {
        throw new AppError('self_delete', 'You cannot remove the account you are signed in with.');
      }
      const existing = findUserById(ctx.db, input.id);
      if (!existing) throw new AppError('not_found', 'That user no longer exists.');
      assertNotLastAdmin(ctx.db, input.id);

      ctx.db.transaction(() => {
        softDeleteUser(ctx.db, input.id);
        writeAudit(ctx.db, {
          userId: ctx.user.id,
          action: 'user.delete',
          entity: 'user',
          entityId: input.id,
          summary: `Removed account "${existing.fullName}"`,
          before: existing,
        });
      })();

      return { ok: true };
    },
  });

  // --- Settings ----------------------------------------------------------

  defineOp({
    op: 'settings.get',
    input: z.void().optional(),
    handler: (_input, ctx) => getSettings(ctx.db),
  });

  defineOp({
    op: 'settings.save',
    permission: 'settings.manage',
    input: z.object({
      shopName: z.string().min(2).max(80).optional(),
      addressLine1: z.string().max(120).optional(),
      addressLine2: z.string().max(120).optional(),
      phone: z.string().max(40).optional(),
      logoPath: z.string().nullable().optional(),
      invoicePrefix: z.string().min(1).max(8).optional(),
      enforceMinPrice: z.boolean().optional(),
      blockNegativeStock: z.boolean().optional(),
      footerNote: z.string().max(300).optional(),
    }),
    handler: (input, ctx) => updateSettings(ctx.db, input, ctx.user.id),
  });

  /** The shop logo, shown in Settings and printed on every receipt. */
  defineOp({
    op: 'settings.logo',
    input: z.void().optional(),
    handler: (_input, ctx) => ({ dataUrl: readPhoto(getSettings(ctx.db).logoPath) }),
  });

  defineOp({
    op: 'settings.chooseLogo',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: async (_input, ctx) => {
      const picked = await chooseImage('Choose the shop logo');
      if (!picked) return { cancelled: true as const };
      const { logoPath } = setShopLogo(picked);
      updateSettings(ctx.db, { logoPath }, ctx.user.id);
      return { cancelled: false as const, dataUrl: readPhoto(logoPath) };
    },
  });

  defineOp({
    op: 'settings.clearLogo',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => {
      updateSettings(ctx.db, { logoPath: null }, ctx.user.id);
      return { ok: true };
    },
  });

  // --- Data health -------------------------------------------------------

  /**
   * Check the two cached figures against the records they summarise.
   *
   * Stock and customer balances are only ever written inside the transaction
   * that produced them, so they should never drift — but a cache nobody can
   * verify is a cache nobody should trust.
   */
  defineOp({
    op: 'data.check',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => ({
      stock: findStockMismatches(ctx.db),
      ledger: findLedgerMismatches(ctx.db),
    }),
  });

  defineOp({
    op: 'data.repairStock',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => ({ repaired: repairStockCache(ctx.db, ctx.user.id) }),
  });

  // --- Backups -----------------------------------------------------------

  defineOp({
    op: 'backup.list',
    permission: 'backup.manage',
    input: z.void().optional(),
    handler: () => listBackups(),
  });

  defineOp({
    op: 'backup.create',
    permission: 'backup.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => createBackup(ctx.db, 'manual', ctx.user.id),
  });

  defineOp({
    op: 'backup.inspectRestore',
    permission: 'backup.manage',
    input: z.object({ path: z.string().min(1) }),
    handler: (input) => inspectBackup(input.path),
  });

  /**
   * Put a backup back in place of the live database.
   *
   * The order here is the whole point. The backup is proved readable first, the
   * audit line is written while the live database still exists, and only then
   * is the connection closed and the file swapped — because SQLite holds the
   * file open and Windows will not rename a file that is open. The app then
   * relaunches itself onto the restored data.
   */
  defineOp({
    op: 'backup.restore',
    permission: 'backup.manage',
    input: z.object({ path: z.string().min(1), confirm: z.literal(true) }),
    handler: (input, ctx) => {
      const summary = inspectBackup(input.path);

      writeAudit(ctx.db, {
        userId: ctx.user.id,
        action: 'backup.restore',
        entity: 'backup',
        entityId: input.path,
        summary: `Restored the database from ${input.path}`,
        after: summary,
      });

      // No separate safety copy is needed: restoreBackup moves the live
      // database aside as *-replaced.db, which *is* the copy of where things
      // stand right now. Taking another one here was redundant, and could
      // collide with the backup being restored from.
      closeDatabase();
      const result = restoreBackup(input.path);

      // Relaunch on the next tick so this reply reaches the screen first.
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 400);

      return { ...result, ...summary, restartRequired: true };
    },
  });

  defineOp({
    op: 'folder.open',
    input: z.object({ which: z.enum(['backups', 'receipts']) }),
    handler: async (input) => {
      const target = input.which === 'backups' ? backupsDir() : receiptsDir();
      await shell.openPath(target);
      return { path: target };
    },
  });

  // --- Audit log ---------------------------------------------------------

  defineOp({
    op: 'audit.list',
    permission: 'audit.view',
    input: z
      .object({
        entity: z.string().max(40).optional(),
        entityId: z.string().max(64).optional(),
        userId: z.string().max(64).optional(),
        action: z.string().max(60).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional(),
    handler: (input, ctx) => listAudit(ctx.db, input ?? {}),
  });
}
