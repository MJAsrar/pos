/**
 * Customer ledger arithmetic.
 *
 * The ledger is append-only: every event that moves a customer's balance writes
 * one signed row. `customers.balance` is only a cache of the sum, so a balance
 * can always be proved line by line — which is the whole reason for replacing
 * the paper registers.
 *
 * Sign convention: positive means the customer owes the shop more.
 */

import type { Paisa } from '../money.js';
import type { LedgerEntryType } from '../types/index.js';

export interface LedgerMovement {
  type: LedgerEntryType;
  /** Always positive here; `signedAmount` applies the direction. */
  amount: Paisa;
}

/**
 * Turn an event into a signed ledger amount.
 *
 * `opening` and `adjustment` pass through signed, because an opening balance can
 * be an advance the customer has already paid, and an adjustment can go either way.
 */
export function signedAmount(type: LedgerEntryType, amount: Paisa): Paisa {
  switch (type) {
    case 'credit_sale':
      return Math.abs(amount);
    case 'payment':
    case 'return_credit':
      return -Math.abs(amount);
    case 'opening':
    case 'adjustment':
      return amount;
  }
}

export interface BalanceEntry {
  amount: Paisa;
  balanceAfter: Paisa;
}

/** Running balance after applying a signed amount. */
export function applyToBalance(balance: Paisa, signed: Paisa): Paisa {
  return balance + signed;
}

/** Sum a customer's ledger from scratch. */
export function recomputeBalance(entries: readonly { amount: Paisa }[]): Paisa {
  let balance = 0;
  for (const entry of entries) balance += entry.amount;
  return balance;
}

export interface LedgerCheck {
  ok: boolean;
  computed: Paisa;
  /** Index of the first entry whose stored `balanceAfter` disagrees with the sum. */
  firstMismatchIndex: number | null;
}

/**
 * Verify that stored running balances match the sum of the entries.
 *
 * Powers the "verify balances" action on the Settings screen. A mismatch means a
 * cache went stale or a row was edited outside a transaction, and the owner needs
 * to know before trusting a dues report.
 */
export function verifyLedger(entries: readonly BalanceEntry[]): LedgerCheck {
  let running = 0;
  let firstMismatchIndex: number | null = null;

  entries.forEach((entry, index) => {
    running += entry.amount;
    if (firstMismatchIndex === null && running !== entry.balanceAfter) {
      firstMismatchIndex = index;
    }
  });

  return { ok: firstMismatchIndex === null, computed: running, firstMismatchIndex };
}

/** How many days old the oldest unsettled amount is — used for the dues report. */
export function daysOutstanding(oldestEntryDate: string, now: Date = new Date()): number {
  const then = new Date(oldestEntryDate).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

export type DueBucket = 'current' | '30' | '60' | '90plus';

export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
  current: 'Under 30 days',
  '30': '30 - 59 days',
  '60': '60 - 89 days',
  '90plus': '90+ days',
};

export function dueBucket(days: number): DueBucket {
  if (days >= 90) return '90plus';
  if (days >= 60) return '60';
  if (days >= 30) return '30';
  return 'current';
}
