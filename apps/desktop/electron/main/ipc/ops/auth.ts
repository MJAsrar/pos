import { app } from 'electron';
import { z } from 'zod';
import { effectivePermissions } from '@pos/shared';
import { AppError, defineOp } from '../router.js';
import {
  PIN_LENGTH,
  createUser,
  login,
  loginOptions,
  logout,
  needsFirstRunSetup,
} from '../../services/authService.js';
import { createCategory } from '../../services/itemService.js';
import { getSettings, updateSettings } from '../../services/settingsService.js';
import { updateState } from '../../services/updateService.js';
import { getSessionUser, sessionStartedAt } from '../../session.js';

const pinSchema = z
  .string()
  .regex(new RegExp(`^\\d{${PIN_LENGTH}}$`), `The PIN must be exactly ${PIN_LENGTH} digits.`);

/**
 * The shelves this shop actually has, created on first run.
 *
 * Starting a new install with an empty Items screen and no way to group
 * anything is a worse first hour than starting with the bins already labelled.
 * All of them can be renamed, added to or deleted afterwards.
 */
const STARTER_CATEGORIES = [
  'Compressor',
  'Pipe + Condenser',
  'Freezer plate',
  'Capacitor',
  'Fridge Parts',
  'A.C Parts',
  'Tools',
  'Dispenser + Cone Machine',
  'Oven + Fan',
  'Washing Machine',
  'Electronics',
  'Cylinder + Stove',
  'Heater',
  'Other',
];

/**
 * Authentication operations.
 *
 * These are the only `public` ops in the app — everything else requires a signed-in
 * session. `app.status` is what the renderer calls on boot to decide between the
 * first-run setup screen, the login screen and the counter.
 */
export function registerAuthOps(): void {
  defineOp({
    op: 'app.status',
    public: true,
    input: z.void().optional(),
    handler: (_input, ctx) => {
      const user = getSessionUser();
      const settings = getSettings(ctx.db);
      return {
        version: app.getVersion(),
        update: updateState(),
        needsSetup: needsFirstRunSetup(ctx.db),
        shopName: settings.shopName,
        signedIn: user
          ? {
              user: { ...user, permissions: effectivePermissions(user) },
              since: sessionStartedAt(),
            }
          : null,
      };
    },
  });

  defineOp({
    op: 'auth.loginOptions',
    public: true,
    input: z.void().optional(),
    handler: (_input, ctx) => loginOptions(ctx.db),
  });

  defineOp({
    op: 'auth.login',
    public: true,
    input: z.object({ userId: z.string().min(1), pin: pinSchema }),
    handler: async (input, ctx) => {
      const result = await login(ctx.db, input.userId, input.pin);
      return {
        user: { ...result.user, permissions: effectivePermissions(result.user) },
        since: result.loggedInAt,
      };
    },
  });

  defineOp({
    op: 'auth.logout',
    input: z.void().optional(),
    handler: () => {
      logout();
      return { ok: true };
    },
  });

  /**
   * First-run setup: create the owner's account and name the shop.
   *
   * Public because there is nobody to authorise it yet — which is exactly why it
   * re-checks that the users table is still empty. Without that check, this op
   * would let anyone mint an admin account at any time.
   */
  defineOp({
    op: 'setup.createOwner',
    public: true,
    input: z.object({
      fullName: z.string().min(2).max(60),
      username: z.string().min(3).max(32),
      pin: pinSchema,
      shopName: z.string().min(2).max(80),
      phone: z.string().max(40).optional(),
      addressLine1: z.string().max(120).optional(),
    }),
    handler: async (input, ctx) => {
      if (!needsFirstRunSetup(ctx.db)) {
        throw new AppError(
          'already_set_up',
          'This system already has users. Sign in instead.',
        );
      }

      const owner = await createUser(
        ctx.db,
        {
          username: input.username,
          fullName: input.fullName,
          pin: input.pin,
          role: 'admin',
        },
        null,
      );

      updateSettings(
        ctx.db,
        {
          shopName: input.shopName.trim(),
          phone: input.phone?.trim() ?? '',
          addressLine1: input.addressLine1?.trim() ?? '',
        },
        owner.id,
      );

      for (const name of STARTER_CATEGORIES) {
        createCategory(ctx.db, name, owner.id);
      }

      const result = await login(ctx.db, owner.id, input.pin);
      return {
        user: { ...result.user, permissions: effectivePermissions(result.user) },
        since: result.loggedInAt,
      };
    },
  });
}
