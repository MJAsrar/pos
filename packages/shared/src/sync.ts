/**
 * The sync contract.
 *
 * Both ends must agree on exactly this: the desktop app, and later the website.
 * The decision functions here are pure so the same rules can be read, reasoned
 * about and tested without a database at either end.
 *
 * The shape of the problem: one shop, one counter PC that is offline most of
 * the day, and a website the owner uses from a phone. Rows change in both
 * places. Nothing here tries to be a general distributed database — it is the
 * smallest set of rules that cannot silently lose a sale.
 */

import type { Timestamp } from './types/index.js';

/**
 * How a table's rows behave, which decides how conflicts are settled.
 *
 * `event` rows are written once and never touched again — a sale line, a stock
 * movement, a ledger entry. Two sides can never disagree about one, because
 * neither ever changes it. Corrections are new rows: a return, a reversing
 * adjustment.
 *
 * `master` rows are edited in place — an item's price, a customer's phone
 * number — so two sides genuinely can disagree, and someone has to win.
 */
export type TableKind = 'event' | 'master';

export const TABLE_KINDS: Record<string, TableKind> = {
  settings: 'master',
  users: 'master',
  categories: 'master',
  items: 'master',
  customers: 'master',
  expenses: 'master',
  // A bill is only ever changed by being voided, which flips `status`.
  sales: 'master',

  sale_items: 'event',
  sale_returns: 'event',
  sale_return_items: 'event',
  stock_movements: 'event',
  customer_ledger_entries: 'event',
  customer_payments: 'event',
  audit_log: 'event',
};

export const SYNCED_TABLES = Object.keys(TABLE_KINDS);

/**
 * Columns that are a local cache of other rows and must never cross the wire.
 *
 * This is the single most important rule in the whole protocol. Stock on hand
 * is the running sum of `stock_movements`; a customer's balance is the running
 * sum of their ledger. If those absolute numbers were synced, a stale value
 * arriving from the website would wipe out a day of offline sales — silently,
 * and with no way to tell afterwards. Movements and ledger entries are signed
 * deltas, they are append-only, and they add up to the same answer whatever
 * order they arrive in. So the deltas sync and the totals are recomputed.
 */
export const DERIVED_COLUMNS: Record<string, readonly string[]> = {
  items: ['qty_on_hand'],
  customers: ['balance'],
};

/** Local bookkeeping that is meaningless on the other side. */
export const LOCAL_ONLY_COLUMNS = ['server_seq'] as const;

export function isSyncedTable(table: string): boolean {
  return table in TABLE_KINDS;
}

export function tableKind(table: string): TableKind | null {
  return TABLE_KINDS[table] ?? null;
}

/** Strip what must not be sent or applied. */
export function stripUnsyncable(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set<string>([...LOCAL_ONLY_COLUMNS, ...(DERIVED_COLUMNS[table] ?? [])]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out;
}

// --- Wire format -----------------------------------------------------------

export interface PushRow {
  table: string;
  id: string;
  /** A soft delete travels as a flag, not an absence. */
  deleted: boolean;
  /** The client's clock. The server clamps it; see `decideMasterWrite`. */
  updatedAt: Timestamp;
  data: Record<string, unknown>;
}

export interface PullRow {
  table: string;
  id: string;
  deleted: boolean;
  /** The server's own monotonic counter — the thing the cursor tracks. */
  serverSeq: number;
  data: Record<string, unknown>;
}

export type RowOutcome = 'ok' | 'conflict' | 'rejected';

export interface RowResult {
  table: string;
  id: string;
  status: RowOutcome;
  /** Set for conflict and rejected, in words a person can act on. */
  reason?: string;
}

export interface SyncRequest {
  deviceId: string;
  clientTime: Timestamp;
  /** Where the last successful pull got to. Null on a first ever sync. */
  cursor: number | null;
  changes: PushRow[];
  pullLimit: number;
}

export interface SyncResponse {
  serverTime: Timestamp;
  results: RowResult[];
  changes: PullRow[];
  cursor: number;
  /** True when more is waiting; the client should go straight round again. */
  hasMore: boolean;
}

/** Anything that can carry a sync round trip, real or fake. */
export interface SyncTransport {
  exchange(request: SyncRequest): Promise<SyncResponse>;
}

// --- The rules ------------------------------------------------------------

/** How far ahead of the server a client clock may be before it is disbelieved. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface MasterDecision {
  outcome: 'accept' | 'conflict' | 'reject';
  /** The timestamp the server should store, which may be clamped. */
  effectiveAt: Timestamp;
  reason?: string;
}

/**
 * Who wins when both sides edited the same master row.
 *
 * Last write wins on `updatedAt`, with two guards that matter more than the
 * rule itself.
 *
 * The timestamp is clamped to the server's own clock before comparison. A
 * counter PC whose clock is three days fast would otherwise win every conflict
 * forever, and nobody would understand why the website's changes kept
 * disappearing.
 *
 * Ties break on device id, so both ends independently reach the same answer
 * rather than flip-flopping.
 */
export function decideMasterWrite(
  incoming: { updatedAt: Timestamp; deviceId: string },
  existing: { updatedAt: Timestamp; deviceId: string } | null,
  serverNow: Timestamp,
): MasterDecision {
  const incomingMs = Date.parse(incoming.updatedAt);
  const nowMs = Date.parse(serverNow);

  if (!Number.isFinite(incomingMs)) {
    return { outcome: 'reject', effectiveAt: serverNow, reason: 'The change had no usable timestamp.' };
  }

  // Wildly ahead means a wrong clock, not a newer edit.
  if (incomingMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return {
      outcome: 'reject',
      effectiveAt: serverNow,
      reason: 'That computer’s clock is set far ahead. Correct the date and time, then try again.',
    };
  }

  const effectiveMs = Math.min(incomingMs, nowMs);
  const effectiveAt = new Date(effectiveMs).toISOString();

  if (!existing) return { outcome: 'accept', effectiveAt };

  const existingMs = Date.parse(existing.updatedAt);
  if (!Number.isFinite(existingMs)) return { outcome: 'accept', effectiveAt };

  if (effectiveMs > existingMs) return { outcome: 'accept', effectiveAt };

  if (effectiveMs === existingMs) {
    return incoming.deviceId > existing.deviceId
      ? { outcome: 'accept', effectiveAt }
      : {
          outcome: 'conflict',
          effectiveAt,
          reason: 'The same row was changed in both places at the same moment.',
        };
  }

  return {
    outcome: 'conflict',
    effectiveAt,
    reason: 'This was changed somewhere else more recently, so that change was kept.',
  };
}

/**
 * Whether an event row should be written.
 *
 * Append-only rows cannot conflict: either the server has it or it does not.
 * Seeing one twice is an ordinary consequence of a retry, not a problem, so it
 * reports success rather than an error.
 */
export function decideEventWrite(exists: boolean): RowOutcome {
  return exists ? 'ok' : 'ok';
}

/** Readable summary for the status line. */
export function describeBacklog(pending: number, failed: number, dead: number): string {
  if (dead > 0) return `${pending + failed} waiting, ${dead} need attention`;
  if (pending + failed === 0) return 'Everything sent';
  const total = pending + failed;
  return `${total} ${total === 1 ? 'change' : 'changes'} waiting`;
}
