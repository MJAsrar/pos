import { z } from 'zod';
import { describeBacklog } from '@pos/shared';
import { defineOp } from '../router.js';
import { cloudAccount, isSignedIn, signIn, signOut } from '../../sync/cloudAuth.js';
import {
  clearSyncBackoff,
  lastSyncRun,
  startSyncScheduler,
  syncNow,
} from '../../services/syncScheduler.js';
import { syncInFlight } from '../../services/syncEngine.js';
import {
  listConflicts,
  markConflictsSeen,
  nextBatch,
  readState,
  retryDead,
  syncStatus,
} from '../../services/syncService.js';

/**
 * What the shop can see and do about sync.
 *
 * Reading the status needs no permission: the one-line indicator belongs in the
 * app chrome for whoever is at the counter, because "14 waiting to go" is
 * something a cashier should notice. Signing the computer in, and everything
 * else, is the owner's job.
 */
export function registerSyncOps(): void {
  defineOp({
    op: 'sync.status',
    input: z.void().optional(),
    handler: (_input, ctx) => {
      const status = syncStatus(ctx.db, isSignedIn());
      return {
        ...status,
        account: cloudAccount(),
        busy: syncInFlight(ctx.db),
        summary: describeBacklog(status.pending, status.failed, status.dead),
        lastRun: lastSyncRun(),
      };
    },
  });

  /**
   * Sign this computer in to the shop's cloud account.
   *
   * The password goes no further than the sign-in request: what is kept is a
   * refresh token, encrypted by Windows for this user on this machine.
   */
  defineOp({
    op: 'sync.signIn',
    permission: 'settings.manage',
    input: z.object({
      email: z.string().trim().min(3).max(200),
      password: z.string().min(1).max(200),
    }),
    handler: async (input) => {
      const { email } = await signIn(input.email, input.password);
      clearSyncBackoff();
      startSyncScheduler();
      // Send everything the shop already has, straight away.
      const run = await syncNow();
      return { email, run };
    },
  });

  defineOp({
    op: 'sync.signOut',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: () => {
      signOut();
      return { ok: true };
    },
  });

  defineOp({
    op: 'sync.now',
    permission: 'settings.manage',
    input: z.void().optional(),
    handler: async () => {
      clearSyncBackoff();
      return syncNow();
    },
  });

  /**
   * The machine says it is back online, so stop waiting out the backoff.
   *
   * No permission: whoever is at the counter when the internet returns should
   * not have to be an owner for the queue to start moving.
   */
  defineOp({
    op: 'sync.resumed',
    input: z.void().optional(),
    handler: async () => {
      clearSyncBackoff();
      const run = await syncNow();
      return { sent: run.sent, received: run.received, problem: run.problem };
    },
  });

  defineOp({
    op: 'sync.conflicts',
    permission: 'settings.manage',
    input: z
      .object({
        limit: z.number().int().min(1).max(200).optional(),
        includeSeen: z.boolean().optional(),
      })
      .optional(),
    handler: (input, ctx) =>
      listConflicts(ctx.db, input?.limit ?? 50, { includeSeen: input?.includeSeen ?? false }),
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
    handler: (input, ctx) => ({
      rows: nextBatch(ctx.db, input?.limit ?? 20),
      cursor: Number(readState(ctx.db, 'cursor') ?? 0),
      deviceId: readState(ctx.db, 'deviceId'),
    }),
  });
}
