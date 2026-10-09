import { describe, expect, it } from 'vitest';
import {
  DERIVED_COLUMNS,
  MAX_CLOCK_SKEW_MS,
  SYNCED_TABLES,
  decideMasterWrite,
  describeBacklog,
  isSyncedTable,
  stripUnsyncable,
  tableKind,
} from './sync.js';

describe('what syncs', () => {
  it('knows the local-only tables are not its business', () => {
    // An invoice sequence is per-terminal; a parked bill is one screen's.
    expect(isSyncedTable('counters')).toBe(false);
    expect(isSyncedTable('held_sales')).toBe(false);
    expect(isSyncedTable('sync_outbox')).toBe(false);
  });

  it('treats rows that are written once as events', () => {
    for (const table of [
      'sale_items',
      'stock_movements',
      'customer_ledger_entries',
      'customer_payments',
      'audit_log',
    ]) {
      expect(tableKind(table)).toBe('event');
    }
  });

  it('treats rows that get edited as master data', () => {
    for (const table of ['items', 'customers', 'users', 'settings', 'expenses']) {
      expect(tableKind(table)).toBe('master');
    }
  });

  it('counts a bill as master, because voiding changes it', () => {
    expect(tableKind('sales')).toBe('master');
  });
});

describe('stripUnsyncable', () => {
  it('never sends stock on hand', () => {
    // The rule the whole design rests on: an absolute quantity crossing the
    // wire could wipe out a day of offline sales. Movements sync instead.
    const stripped = stripUnsyncable('items', {
      id: 'i1',
      name: 'Compressor 1/4 HP',
      sale_price: 1650000,
      qty_on_hand: 42,
    });
    expect(stripped).not.toHaveProperty('qty_on_hand');
    expect(stripped).toMatchObject({ id: 'i1', sale_price: 1650000 });
  });

  it('never sends a customer balance', () => {
    const stripped = stripUnsyncable('customers', { id: 'c1', name: 'Ali', balance: 840000 });
    expect(stripped).not.toHaveProperty('balance');
    expect(stripped.name).toBe('Ali');
  });

  it('strips local bookkeeping from every table', () => {
    for (const table of SYNCED_TABLES) {
      expect(stripUnsyncable(table, { id: 'x', server_seq: 99 })).not.toHaveProperty('server_seq');
    }
  });

  it('leaves a table with nothing derived untouched', () => {
    const row = { id: 'm1', item_id: 'i1', qty_delta: -2, qty_after: 8 };
    expect(stripUnsyncable('stock_movements', row)).toEqual(row);
  });

  it('declares derived columns for exactly the two cached totals', () => {
    expect(Object.keys(DERIVED_COLUMNS).sort()).toEqual(['customers', 'items']);
  });
});

describe('decideMasterWrite', () => {
  const now = '2026-10-10T12:00:00.000Z';
  // Named for which side the edit came from, which the rule no longer needs
  // to know: the server is the only thing that decides.
  const pc = {};
  const web = {};

  it('accepts a change to a row the server has never seen', () => {
    expect(decideMasterWrite({ ...pc, updatedAt: now }, null, now).outcome).toBe('accept');
  });

  it('accepts the newer of two edits', () => {
    const decision = decideMasterWrite(
      { ...pc, updatedAt: '2026-10-10T11:00:00.000Z' },
      { ...web, updatedAt: '2026-10-10T10:00:00.000Z' },
      now,
    );
    expect(decision.outcome).toBe('accept');
  });

  it('refuses the older one, and says why in plain words', () => {
    // The scenario from the plan: the owner repriced on the website at 10:00
    // while the offline PC repriced at 09:00. The website wins.
    const decision = decideMasterWrite(
      { ...pc, updatedAt: '2026-10-10T09:00:00.000Z' },
      { ...web, updatedAt: '2026-10-10T10:00:00.000Z' },
      now,
    );
    expect(decision.outcome).toBe('conflict');
    expect(decision.reason).toMatch(/changed somewhere else more recently/i);
  });

  it('clamps a clock that is ahead, so it cannot win forever', () => {
    // A PC two minutes fast is within tolerance, but its timestamp is pulled
    // back to the server's clock before being compared.
    const ahead = new Date(Date.parse(now) + 2 * 60_000).toISOString();
    const decision = decideMasterWrite({ ...pc, updatedAt: ahead }, null, now);
    expect(decision.outcome).toBe('accept');
    expect(decision.effectiveAt).toBe(now);
  });

  it('refuses a clock that is wildly ahead, and says what to fix', () => {
    const miles = new Date(Date.parse(now) + MAX_CLOCK_SKEW_MS + 60_000).toISOString();
    const decision = decideMasterWrite({ ...pc, updatedAt: miles }, null, now);
    expect(decision.outcome).toBe('reject');
    expect(decision.reason).toMatch(/clock/i);
  });

  it('a clamped clock cannot beat a genuinely newer change', () => {
    // The PC claims a minute into the future; the change on the website is one
    // millisecond newer than the server's clock. Clamping pulls the PC back,
    // so the wrong clock wins it nothing.
    const future = new Date(Date.parse(now) + 60_000).toISOString();
    const decision = decideMasterWrite(
      { ...pc, updatedAt: future },
      { ...web, updatedAt: '2026-10-10T12:00:00.001Z' },
      now,
    );
    expect(decision.outcome).toBe('conflict');
  });

  it('accepts an exact tie rather than losing the edit', () => {
    // The realistic tie is one device editing the same row twice inside a
    // millisecond, with a sync in between. Refusing the second edit would
    // lose it, and would blame a device that never touched it.
    const mine = decideMasterWrite({ ...pc, updatedAt: now }, { ...web, updatedAt: now }, now);
    const theirs = decideMasterWrite({ ...web, updatedAt: now }, { ...pc, updatedAt: now }, now);
    expect([mine.outcome, theirs.outcome]).toEqual(['accept', 'accept']);
  });

  it('rejects a timestamp it cannot read rather than guessing', () => {
    const decision = decideMasterWrite({ ...pc, updatedAt: 'not a date' }, null, now);
    expect(decision.outcome).toBe('reject');
  });

  it('treats an unreadable stored timestamp as no obstacle', () => {
    const decision = decideMasterWrite(
      { ...pc, updatedAt: now },
      { ...web, updatedAt: 'corrupt' },
      now,
    );
    expect(decision.outcome).toBe('accept');
  });
});

describe('describeBacklog', () => {
  it('says nothing is waiting when nothing is', () => {
    expect(describeBacklog(0, 0, 0)).toBe('Everything sent');
  });

  it('counts pending and failed together, because both still have to go', () => {
    expect(describeBacklog(3, 2, 0)).toBe('5 changes waiting');
    expect(describeBacklog(1, 0, 0)).toBe('1 change waiting');
  });

  it('calls out rows that need a person', () => {
    expect(describeBacklog(4, 0, 2)).toBe('4 waiting, 2 need attention');
  });
});
