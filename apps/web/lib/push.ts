/**
 * Changing something from the website.
 *
 * Through `sync_v1`, never by writing to a table. That is not a convention
 * anyone has to remember — the database refuses a direct write even from a
 * signed-in member — and it is the reason the website cannot quietly break the
 * rules the counter plays by. Last-write-wins on a clamped clock, append-only
 * rows deduplicated, and a conflict reported rather than one side silently
 * losing. The shop PC cannot be force-updated, so the rules live in one place
 * and that place is the server.
 *
 * Two things follow, and both matter more than they look.
 *
 * Quantities are never sent. `items` in the cloud has no stock column at all:
 * stock is the running sum of `stock_movements`, and "set this to 50" has to
 * become a movement of `50 − whatever it is now`. An absolute 50 arriving here
 * would erase a day of selling at the counter, and nobody would notice until
 * someone counted the shelf.
 *
 * And a change is attributed to a person at the counter, not to an email. The
 * member row says which account this sign-in acts as.
 */

import {
  countToMovement,
  nowIso,
  rowKey,
  signedAmount,
  uuidv7,
  type PaymentMethod,
  type PushRow,
  type RowResult,
} from '@pos/shared';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, accessToken, read } from './shop';

/** How this device names itself in the audit trail and in conflict messages. */
const DEVICE_ID = 'the-website';

export class PushRefused extends Error {
  readonly results: RowResult[];

  constructor(message: string, results: RowResult[] = []) {
    super(message);
    this.name = 'PushRefused';
    this.results = results;
  }
}

interface SyncReply {
  results?: RowResult[];
  changes?: unknown[];
  cursor?: number;
}

/**
 * Send a set of changes as one transaction.
 *
 * Everything in a single call lands together or not at all, which is why a
 * stock change sends its movement and its reason as one thing rather than two
 * requests that could half-succeed.
 */
export async function pushChanges(changes: PushRow[]): Promise<RowResult[]> {
  if (!changes.length) return [];

  const jwt = await accessToken();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_v1`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload: {
        deviceId: DEVICE_ID,
        clientTime: nowIso(),
        // Nothing to pull: this page reads with ordinary queries and does not
        // keep a copy to keep in step.
        cursor: 0,
        pullLimit: 0,
        changes,
      },
    }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    throw new PushRefused(detail.message ?? `The change could not be saved (${response.status}).`);
  }

  const reply = (await response.json()) as SyncReply;
  const results = reply.results ?? [];

  const refused = results.filter((row) => row.status !== 'ok');
  if (refused.length) {
    // The server's reasons are already written for a person to read.
    throw new PushRefused(refused.map((row) => row.reason).filter(Boolean).join(' ') || 'That change was not accepted.', results);
  }

  return results;
}

// --- Who this sign-in is at the counter ------------------------------------

let actingAs: string | null | undefined;

/**
 * The counter account this sign-in changes things as.
 *
 * Needed because a stock movement and an audit entry both record a person, and
 * "an email address" is not one as far as the shop is concerned. A member with
 * nobody set may look but not change anything, which is a sensible thing to be
 * and not an error until they try.
 */
export async function actingUserId(): Promise<string> {
  if (actingAs === undefined) {
    const rows = await read<{ pos_user_id: string | null }>('shop_members?select=pos_user_id&limit=1');
    actingAs = rows[0]?.pos_user_id ?? null;
  }
  if (!actingAs) {
    throw new PushRefused(
      'This sign-in can look at the shop but not change it. Ask whoever set up the system to link it to your counter account.',
    );
  }
  return actingAs;
}

export function forgetActingUser(): void {
  actingAs = undefined;
}

// --- The changes the website can make --------------------------------------

/**
 * Reprice an item.
 *
 * Only the columns that change are sent, so an older counter PC that knows
 * fewer columns than this database is unaffected, and nothing else about the
 * item is touched by a price edit.
 */
export function repriceItem(
  item: { id: string; salePrice: number; costPrice?: number; minPrice?: number | null },
): Promise<RowResult[]> {
  const when = nowIso();
  const data: Record<string, unknown> = {
    id: item.id,
    sale_price: item.salePrice,
    updated_at: when,
  };
  if (item.costPrice !== undefined) data.cost_price = item.costPrice;
  if (item.minPrice !== undefined) data.min_price = item.minPrice;

  return pushChanges([
    { table: 'items', id: item.id, deleted: false, updatedAt: when, data },
  ]);
}

/**
 * Correct the stock figure for an item.
 *
 * Takes the quantity the shelf actually holds and sends the difference, never
 * the figure itself. If the counter sold three while this page was open, those
 * three are still gone afterwards: the movements add up, in any order they
 * arrive.
 */
export function correctStock(input: {
  itemId: string;
  countedQty: number;
  currentQty: number;
  reason: string;
  userId: string;
}): Promise<RowResult[]> {
  const movement = countToMovement(input.countedQty, input.currentQty);
  if (movement.unchanged) return Promise.resolve([]);

  const when = nowIso();
  const id = uuidv7();

  return pushChanges([
    {
      table: 'stock_movements',
      id,
      deleted: false,
      updatedAt: when,
      data: {
        id,
        item_id: input.itemId,
        type: 'adjustment',
        qty_delta: movement.delta,
        // What it should come to, for the trail. The cloud still works the
        // real figure out by adding the movements up.
        qty_after: movement.qtyAfter,
        reason: input.reason,
        user_id: input.userId,
        created_at: when,
        updated_at: when,
      },
    },
  ]);
}

/**
 * Record money a customer has handed over.
 *
 * Two rows, in one call, because they are one event: the payment itself and
 * the ledger entry that moves the balance. Separate requests could half
 * succeed and leave a receipt with no effect on what the customer owes, or an
 * effect with no receipt behind it.
 *
 * The balance itself is not sent. `customers` in the cloud has no balance
 * column -- it is the sum of the ledger, and the counter adds it up again when
 * these rows reach it. `balance_after` travels only as the trail, so the
 * history reads downward the way a register does.
 *
 * The sign comes from `signedAmount`, which is the same function the till
 * uses: a payment reduces what is owed, and getting that backwards would
 * double a debt rather than clear it.
 */
export function receivePayment(input: {
  customerId: string;
  amount: number;
  currentBalance: number;
  method: PaymentMethod;
  note?: string | null;
  userId: string;
}): Promise<RowResult[]> {
  const amount = Math.round(input.amount);
  if (amount <= 0) {
    return Promise.reject(new PushRefused('Enter the amount the customer handed over.'));
  }

  const when = nowIso();
  const paymentId = uuidv7();
  const entryId = uuidv7();
  const signed = signedAmount('payment', amount);
  const note = input.note?.trim() || null;

  return pushChanges([
    {
      table: 'customer_payments',
      id: paymentId,
      deleted: false,
      updatedAt: when,
      data: {
        id: paymentId,
        customer_id: input.customerId,
        amount,
        method: input.method,
        received_at: when,
        user_id: input.userId,
        note,
        created_at: when,
        updated_at: when,
      },
    },
    {
      table: 'customer_ledger_entries',
      id: entryId,
      deleted: false,
      updatedAt: when,
      data: {
        id: entryId,
        customer_id: input.customerId,
        type: 'payment',
        amount: signed,
        balance_after: input.currentBalance + signed,
        ref_type: 'payment',
        ref_id: paymentId,
        note,
        user_id: input.userId,
        entry_date: when,
        created_at: when,
        updated_at: when,
      },
    },
  ]);
}

/** For messages that name a row. */
export { rowKey };
