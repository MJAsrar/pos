import { describe, expect, it } from 'vitest';
import {
  daysOutstanding,
  dueBucket,
  recomputeBalance,
  signedAmount,
  verifyLedger,
} from './ledger.js';

describe('signedAmount', () => {
  it('increases what the customer owes on a credit sale', () => {
    expect(signedAmount('credit_sale', 50000)).toBe(50000);
  });

  it('reduces the balance on a payment or a return credit', () => {
    expect(signedAmount('payment', 50000)).toBe(-50000);
    expect(signedAmount('return_credit', 50000)).toBe(-50000);
  });

  it('normalises the sign so a mis-signed input cannot invert the meaning', () => {
    expect(signedAmount('credit_sale', -50000)).toBe(50000);
    expect(signedAmount('payment', -50000)).toBe(-50000);
  });

  it('passes opening balances and adjustments through signed', () => {
    // A customer who paid an advance starts with a negative balance.
    expect(signedAmount('opening', -20000)).toBe(-20000);
    expect(signedAmount('opening', 20000)).toBe(20000);
    expect(signedAmount('adjustment', -1500)).toBe(-1500);
  });
});

describe('recomputeBalance', () => {
  it('sums an empty ledger to zero', () => {
    expect(recomputeBalance([])).toBe(0);
  });

  it('reproduces a realistic khata', () => {
    const entries = [
      { amount: signedAmount('opening', 300000) },
      { amount: signedAmount('credit_sale', 125000) },
      { amount: signedAmount('payment', 200000) },
      { amount: signedAmount('credit_sale', 80000) },
      { amount: signedAmount('return_credit', 25000) },
    ];
    // 3000 + 1250 - 2000 + 800 - 250 = Rs 2,800
    expect(recomputeBalance(entries)).toBe(280000);
  });

  it('settles to exactly zero when a customer clears their account', () => {
    const entries = [
      { amount: signedAmount('credit_sale', 125000) },
      { amount: signedAmount('credit_sale', 80000) },
      { amount: signedAmount('payment', 205000) },
    ];
    expect(recomputeBalance(entries)).toBe(0);
  });
});

describe('verifyLedger', () => {
  it('accepts a ledger whose running balances are consistent', () => {
    const result = verifyLedger([
      { amount: 300000, balanceAfter: 300000 },
      { amount: 125000, balanceAfter: 425000 },
      { amount: -200000, balanceAfter: 225000 },
    ]);
    expect(result).toEqual({ ok: true, computed: 225000, firstMismatchIndex: null });
  });

  it('points at the first entry where the stored balance drifted', () => {
    const result = verifyLedger([
      { amount: 300000, balanceAfter: 300000 },
      { amount: 125000, balanceAfter: 999999 },
      { amount: -200000, balanceAfter: 225000 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.firstMismatchIndex).toBe(1);
    // The true balance is still recoverable from the entries themselves.
    expect(result.computed).toBe(225000);
  });

  it('treats an empty ledger as consistent', () => {
    expect(verifyLedger([])).toEqual({ ok: true, computed: 0, firstMismatchIndex: null });
  });
});

describe('daysOutstanding', () => {
  const now = new Date('2026-09-20T12:00:00Z');

  it('counts whole days since the entry', () => {
    expect(daysOutstanding('2026-09-20T09:00:00Z', now)).toBe(0);
    expect(daysOutstanding('2026-09-15T12:00:00Z', now)).toBe(5);
    expect(daysOutstanding('2026-06-22T12:00:00Z', now)).toBe(90);
  });

  it('never returns a negative age for a future-dated entry', () => {
    expect(daysOutstanding('2026-12-01T12:00:00Z', now)).toBe(0);
  });

  it('returns zero rather than NaN for an unparseable date', () => {
    expect(daysOutstanding('not-a-date', now)).toBe(0);
  });
});

describe('dueBucket', () => {
  it('buckets ages at the boundaries', () => {
    expect(dueBucket(0)).toBe('current');
    expect(dueBucket(29)).toBe('current');
    expect(dueBucket(30)).toBe('30');
    expect(dueBucket(59)).toBe('30');
    expect(dueBucket(60)).toBe('60');
    expect(dueBucket(89)).toBe('60');
    expect(dueBucket(90)).toBe('90plus');
    expect(dueBucket(365)).toBe('90plus');
  });
});
