import { z } from 'zod';
import { defineOp } from '../router.js';
import {
  listConflicts,
  markConflictsSeen,
  nextBatch,
  retryDead,
  syncStatus,
} from '../../services/syncService.js';

/**
 * What the shop can see and do about sync.
 *
 * Reading the status needs no permission: the one-line indicator belongs in
 * the app chrome for whoever is at the counter, because "14 waiting to go" is
 * something a cashier should notice. Acting on it is an owner's job.
 */
export function registerSyncOps(): void {
  defineOp({
    op: 'sync.status',
    input: z.void().optional(),
    // No server is configured yet; this reports honestly rather than pretending.
    handler: (_input, ctx) => syncStatus(ctx.db, false),
  });

  defineOp({
    op: 'sync.conflicts',
    permission: 'settings.manage',
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }).optional(),
    handler: (input, ctx) => listConflicts(ctx.db, input?.limit ?? 50),
  });

  defineOp({
    op: 'sync.acknowledgeConflicts',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => {
      markConflictsSeen(ctx.db);
      return { ok: true };
    },
  });

  defineOp({
    op: 'sync.retryDead',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: (_input, ctx) => ({ requeued: retryDead(ctx.db) }),
  });

  /** What is at the front of the queue, for diagnosing a stuck sync. */
  defineOp({
    op: 'sync.peekQueue',
    permission: 'settings.manage',
    input: z.object({ limit: z.number().int().min(1).max(100).optional() }).optional(),
    handler: (input, ctx) => nextBatch(ctx.db, input?.limit ?? 20),
  });
}
