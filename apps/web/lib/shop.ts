/**
 * The owner's view of the shop, read straight from the cloud copy.
 *
 * No server of our own in the middle. The browser signs in as the owner and
 * reads with that session, and row-level security decides what comes back —
 * the same boundary the counter relies on, rather than a second one written
 * here. Nothing in this file is a secret: the project address and the
 * publishable key are meant to be in a browser bundle, and on their own they
 * grant nothing.
 *
 * Writes do not go through here at all. They cannot: the database refuses a
 * direct write even from a signed-in member, deliberately, so that every
 * change passes the same conflict rules the counter does. Changing anything
 * means calling `sync_v1`, which `push.ts` does.
 */

import {
  rangeToTimestamps,
  summarisePeriod,
  type DateRange,
  type PeriodSummary,
} from '@pos/shared';

export const SUPABASE_URL = 'https://tjanpttaenyqidoltlpk.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_9z0NURwmeUfH4lMWUZ7fAA_dZMOSsHB';

const SESSION_KEY = 'alhamza.session';

/**
 * Long enough for a slow phone, short enough that a stalled connection
 * becomes a sentence rather than a page that says "Loading" forever.
 *
 * The shop is on mobile internet that comes and goes. Without this, a request
 * that never completes leaves the screen in a state nobody can interpret and
 * nothing to do but reload and hope.
 */
const TIMEOUT_MS = 20_000;

function fetchOrGiveUp(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((cause: unknown) => {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      throw new Error('The connection is too slow to read the shop right now. Try again in a moment.');
    }
    throw new Error('There is no connection to the shop right now.');
  });
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
}

// --- Signing in ------------------------------------------------------------

export function readSession(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session): void {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // A browser with storage blocked can still be used; the sign-in just
    // will not outlast the tab.
  }
}

export function forgetSession(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to forget.
  }
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
  msg?: string;
}

async function token(grant: 'password' | 'refresh_token', body: Record<string, string>, email: string): Promise<Session> {
  const response = await fetchOrGiveUp(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = (await response.json().catch(() => ({}))) as TokenReply;

  if (!response.ok || !reply.access_token || !reply.refresh_token) {
    throw new Error(
      grant === 'password'
        ? 'That email and password were not accepted. Check both and try again.'
        : 'Your sign-in has expired. Please sign in again.',
    );
  }

  const session: Session = {
    accessToken: reply.access_token,
    refreshToken: reply.refresh_token,
    expiresAt: Date.now() + (reply.expires_in ?? 3600) * 1000,
    email,
  };
  writeSession(session);
  return session;
}

export function signIn(email: string, password: string): Promise<Session> {
  return token('password', { email, password }, email.trim());
}

/** A usable token, renewed if it is close to expiring. */
export async function accessToken(): Promise<string> {
  const session = readSession();
  if (!session) throw new Error('Not signed in.');
  if (session.expiresAt - 60_000 > Date.now()) return session.accessToken;

  // Supabase hands out a fresh refresh token each time and retires the old
  // one, so the new one has to be kept or the next renewal fails.
  const renewed = await token('refresh_token', { refresh_token: session.refreshToken }, session.email);
  return renewed.accessToken;
}

// --- Reading ---------------------------------------------------------------

export { fetchOrGiveUp };

export async function read<T>(path: string): Promise<T[]> {
  const jwt = await accessToken();
  const response = await fetchOrGiveUp(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${jwt}` },
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(detail.message ?? `The shop data could not be read (${response.status}).`);
  }
  return (await response.json()) as T[];
}

// --- The figures for a period ---------------------------------------------

interface BillRow {
  total: number;
  cost_total: number;
  paid: number;
  subtotal: number;
  discount: number;
}

interface RefundRow {
  total: number;
  cost_total: number;
}

interface ExpenseRow {
  amount: number;
}

/**
 * Takings, profit and what went on udhaar, for a range of shop days.
 *
 * Summed here from the rows rather than by the database, because the
 * arithmetic that turns them into figures is in `@pos/shared` and must be the
 * same arithmetic the till uses. A shop of this size has a few hundred bills a
 * month, so there is nothing to gain by pushing the sums into Postgres and
 * having two implementations to keep level.
 *
 * Cancelled bills are left out and returns come off both sides, which is what
 * `summarisePeriod` expects of whoever gathers the rows.
 */
export async function periodFigures(range: DateRange): Promise<PeriodSummary> {
  const { start, end } = rangeToTimestamps(range);
  const window = `sold_at=gte.${start}&sold_at=lt.${end}`;

  const [bills, refunds, expenses] = await Promise.all([
    read<BillRow>(
      `sales?select=total,cost_total,paid,subtotal,discount&status=eq.active&deleted_at=is.null&${window}`,
    ),
    read<RefundRow>(
      `sale_returns?select=total,cost_total&deleted_at=is.null&returned_at=gte.${start}&returned_at=lt.${end}`,
    ),
    read<ExpenseRow>(
      `expenses?select=amount&deleted_at=is.null&spent_at=gte.${start}&spent_at=lt.${end}`,
    ),
  ]);

  const sum = <T>(rows: readonly T[], pick: (row: T) => number): number =>
    rows.reduce((running, row) => running + pick(row), 0);

  return summarisePeriod({
    bills: {
      count: bills.length,
      gross: sum(bills, (b) => b.subtotal),
      discounts: sum(bills, (b) => b.discount),
      total: sum(bills, (b) => b.total),
      costTotal: sum(bills, (b) => b.cost_total),
      paid: sum(bills, (b) => b.paid),
      credit: sum(bills, (b) => b.total - b.paid),
    },
    returns: {
      total: sum(refunds, (r) => r.total),
      costTotal: sum(refunds, (r) => r.cost_total),
    },
    expenses: sum(expenses, (e) => e.amount),
  });
}

// --- The catalogue --------------------------------------------------------

export interface ShopItem {
  id: string;
  code: string;
  name: string;
  categoryName: string | null;
  unit: string;
  costPrice: number;
  salePrice: number;
  minPrice: number | null;
  lowStockLevel: number;
  /** Added up from the movements, never a stored figure. */
  qtyOnHand: number;
}

interface ItemRow {
  id: string;
  code: string;
  name: string;
  category_id: string | null;
  unit: string;
  cost_price: number;
  sale_price: number;
  min_price: number | null;
  low_stock_level: number;
}

/**
 * The catalogue, with what is on the shelf.
 *
 * Stock comes from the `item_stock` view rather than from the items rows,
 * because the cloud has no stock column: it is the sum of the movements. The
 * two are fetched together and matched up here — fifty-odd items, so there is
 * nothing to be gained by making the database do it.
 */
export async function listItems(): Promise<ShopItem[]> {
  const [items, stock, categories] = await Promise.all([
    read<ItemRow>(
      'items?select=id,code,name,category_id,unit,cost_price,sale_price,min_price,low_stock_level&deleted_at=is.null&order=code',
    ),
    read<{ item_id: string; qty_on_hand: number }>('item_stock?select=item_id,qty_on_hand'),
    read<{ id: string; name: string }>('categories?select=id,name&deleted_at=is.null'),
  ]);

  const onHand = new Map(stock.map((row) => [row.item_id, row.qty_on_hand]));
  const categoryName = new Map(categories.map((row) => [row.id, row.name]));

  return items.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    categoryName: row.category_id ? (categoryName.get(row.category_id) ?? null) : null,
    unit: row.unit,
    costPrice: row.cost_price,
    salePrice: row.sale_price,
    minPrice: row.min_price,
    lowStockLevel: row.low_stock_level,
    qtyOnHand: onHand.get(row.id) ?? 0,
  }));
}

// --- Customers and what they owe ------------------------------------------

export interface ShopCustomer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  /** Added up from the ledger, never a stored figure. */
  balance: number;
}

/**
 * Who owes what.
 *
 * Balances come from the `customer_balance` view for the same reason stock
 * does: the cloud has no balance column, because a figure arriving from
 * elsewhere could overwrite a day of udhaar taken at the counter. The ledger
 * entries are the truth and the view adds them up.
 */
export async function listCustomers(): Promise<ShopCustomer[]> {
  const [customers, balances] = await Promise.all([
    read<{ id: string; name: string; phone: string | null; address: string | null }>(
      'customers?select=id,name,phone,address&deleted_at=is.null&order=name',
    ),
    read<{ customer_id: string; balance: number }>('customer_balance?select=customer_id,balance'),
  ]);

  const owing = new Map(balances.map((row) => [row.customer_id, row.balance]));
  return customers.map((row) => ({ ...row, balance: owing.get(row.id) ?? 0 }));
}

export interface LedgerLine {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  refLabel: string | null;
  note: string | null;
  entryDate: string;
}

/** A customer's history, oldest first so the running balance reads downward. */
export async function customerLedger(customerId: string): Promise<LedgerLine[]> {
  const rows = await read<{
    id: string;
    type: string;
    amount: number;
    balance_after: number;
    ref_label: string | null;
    note: string | null;
    entry_date: string;
  }>(
    `customer_ledger_entries?select=id,type,amount,balance_after,ref_label,note,entry_date` +
      `&customer_id=eq.${customerId}&deleted_at=is.null&order=entry_date.asc,id.asc`,
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balance_after,
    refLabel: row.ref_label,
    note: row.note,
    entryDate: row.entry_date,
  }));
}

// --- What the shop is called ----------------------------------------------

export async function shopName(): Promise<string> {
  const rows = await read<{ value: string }>(`settings?select=value&key=eq.shopName`);
  try {
    return rows[0] ? (JSON.parse(rows[0].value) as string) : 'Al Hamza Electronics';
  } catch {
    return 'Al Hamza Electronics';
  }
}
