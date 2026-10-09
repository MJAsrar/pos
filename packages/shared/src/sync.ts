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
 * Last write wins on `updatedAt`, clamped to the server's own clock before
 * comparison. A counter PC whose clock is three days fast would otherwise win
 * every conflict forever, and nobody would understand why the changes made on
 * the website kept disappearing.
 *
 * An exact tie is accepted rather than refused. Timestamps carry milliseconds,
 * so the realistic tie is not two devices at once — it is one device editing
 * the same row twice inside a millisecond with a sync in between. Refusing the
 * second edit loses it silently, and tells the shop it was changed somewhere
 * else, which is not even true.
 *
 * Accepting is safe because only one place ever runs this: the server, which
 * handles one request at a time. Last to arrive wins, every device then pulls
 * that same value, and they converge. An earlier version broke ties on device
 * id so both ends would independently reach the same answer — but no client
 * ever decides, so there was never a second answer to agree with.
 */
export function decideMasterWrite(
  incoming: { updatedAt: Timestamp },
  existing: { updatedAt: Timestamp } | null,
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

  if (effectiveMs >= existingMs) return { outcome: 'accept', effectiveAt };

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

// --- Order ----------------------------------------------------------------

/**
 * The order rows must be written in: parents before the rows that point at them.
 *
 * Needed on both ends, for opposite reasons. Pushing in this order means the
 * server sees a bill before its lines. Applying in this order means SQLite's
 * foreign keys are satisfied as a pulled batch is written — the outbox is
 * ordered by time and then by table name, and `sale_items` sorts before
 * `sales` alphabetically, which would otherwise put every bill's lines ahead
 * of the bill.
 */
export const APPLY_ORDER: readonly string[] = [
  // Nothing points at anything.
  'settings',
  'users',
  'categories',
  // Point at a category.
  'items',
  'customers',
  // Point at a customer and a user.
  'sales',
  'expenses',
  // Point at a bill, an item or a customer.
  'sale_items',
  'sale_returns',
  'stock_movements',
  'customer_ledger_entries',
  'customer_payments',
  // Points at a return and at the sale line being returned.
  'sale_return_items',
  'audit_log',
];

/** Where a table sits in that order. Unknown tables go last. */
export function applyRank(table: string): number {
  const index = APPLY_ORDER.indexOf(table);
  return index === -1 ? APPLY_ORDER.length : index;
}

/** Sort rows so parents are written before their children. */
export function inApplyOrder<T extends { table: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => applyRank(a.table) - applyRank(b.table));
}

// --- Identifying one row across the wire ----------------------------------

export function rowKey(table: string, id: string): string {
  return `${table}:${id}`;
}

export function parseRowKey(key: string | null | undefined): { table: string; id: string } | null {
  if (!key) return null;
  const at = key.indexOf(':');
  if (at <= 0 || at === key.length - 1) return null;
  return { table: key.slice(0, at), id: key.slice(at + 1) };
}

// --- Failures -------------------------------------------------------------

/**
 * The server answered, and refused.
 *
 * Distinct from an ordinary `Error`, which means the server could not be
 * reached at all. The difference decides what happens next: a refusal counts
 * against the row's attempts and eventually sets it aside, while being offline
 * counts against nothing. A shop with a week of bad internet must not come
 * back to a queue full of rows marked dead.
 *
 * `row` is set when the server could say which row it choked on, which lets
 * the engine set that one aside and send everything else.
 */
export class SyncServerError extends Error {
  readonly code: string | null;
  readonly row: { table: string; id: string } | null;

  constructor(
    message: string,
    options: { code?: string | null; rowKey?: string | null } = {},
  ) {
    super(message);
    this.name = 'SyncServerError';
    this.code = options.code ?? null;
    this.row = parseRowKey(options.rowKey);
  }
}

/** The terminal's sign-in has lapsed and a person has to enter it again. */
export class SyncAuthError extends Error {
  constructor(message = 'This computer needs to be signed in to the cloud again.') {
    super(message);
    this.name = 'SyncAuthError';
  }
}

/** Readable summary for the status line. */
export function describeBacklog(pending: number, failed: number, dead: number): string {
  if (dead > 0) return `${pending + failed} waiting, ${dead} need attention`;
  if (pending + failed === 0) return 'Everything sent';
  const total = pending + failed;
  return `${total} ${total === 1 ? 'change' : 'changes'} waiting`;
}
