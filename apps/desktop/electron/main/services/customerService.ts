import type BetterSqlite3 from 'better-sqlite3';
import {
  nowIso,
  signedAmount,
  uuidv7,
  verifyLedger,
  type LedgerEntryType,
  type SettledMethod,
} from '@pos/shared';
import { AppError } from '../errors.js';
import {
  customerHasHistory,
  findCustomerById,
  insertCustomer,
  softDeleteCustomer,
  updateCustomer,
  type CustomerRecord,
} from '../db/repos/customerRepo.js';
import { writeAudit } from './auditService.js';

/**
 * Customer credit — the udhaar khata.
 *
 * The ledger is append-only. Every event that moves what a customer owes writes
 * one signed row carrying the balance that resulted, and `customers.balance` is
 * only a cache of the running sum. That is what makes "prove this customer owes
 * Rs 8,400" answerable line by line, which a single balance column never is.
 */

export interface LedgerEntryInput {
  customerId: string;
  type: LedgerEntryType;
  /** Magnitude; `signedAmount` applies the direction for the entry type. */
  amount: number;
  refType?: string | null;
  refId?: string | null;
  refLabel?: string | null;
  note?: string | null;
  userId: string;
  entryDate?: string;
}

/**
 * Append one ledger entry and roll the cached balance forward.
 *
 * MUST be called inside an open transaction — the entry, the balance cache and
 * whatever caused them have to land together or not at all.
 */
export function appendLedgerEntry(
  db: BetterSqlite3.Database,
  input: LedgerEntryInput,
): { balanceAfter: number; amount: number } {
  const current = db
    .prepare(`SELECT balance FROM customers WHERE id = ? AND deleted_at IS NULL`)
    .get(input.customerId) as { balance: number } | undefined;

  if (!current) throw new AppError('not_found', 'That customer no longer exists.');

  const amount = signedAmount(input.type, Math.round(input.amount));
  const balanceAfter = current.balance + amount;
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO customer_ledger_entries
       (id, customer_id, type, amount, balance_after, ref_type, ref_id, ref_label,
        note, user_id, entry_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(),
    input.customerId,
    input.type,
    amount,
    balanceAfter,
    input.refType ?? null,
    input.refId ?? null,
    input.refLabel ?? null,
    input.note ?? null,
    input.userId,
    input.entryDate ?? timestamp,
    timestamp,
    timestamp,
  );

  db.prepare(`UPDATE customers SET balance = ?, updated_at = ? WHERE id = ?`).run(
    balanceAfter,
    timestamp,
    input.customerId,
  );

  return { balanceAfter, amount };
}

export interface SaveCustomerInput {
  id?: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive?: boolean;
  /**
   * Only honoured when creating: what the paper register says this customer
   * already owes. Positive means they owe the shop; negative is an advance.
   */
  openingBalance?: number;
}

export function createCustomer(
  db: BetterSqlite3.Database,
  input: SaveCustomerInput,
  userId: string,
): CustomerRecord {
  const name = input.name.trim();
  if (name.length < 2) throw new AppError('invalid_name', 'Enter the customer’s name.');

  const id = uuidv7();
  const opening = Math.round(input.openingBalance ?? 0);

  db.transaction(() => {
    insertCustomer(db, {
      id,
      name,
      phone: normalisePhone(input.phone),
      address: input.address?.trim() || null,
      openingBalance: opening,
      notes: input.notes?.trim() || null,
    });

    if (opening !== 0) {
      appendLedgerEntry(db, {
        customerId: id,
        type: 'opening',
        amount: opening,
        note: 'Balance carried over from the register',
        userId,
      });
    }

    writeAudit(db, {
      userId,
      action: 'customer.create',
      entity: 'customer',
      entityId: id,
      summary: `Added customer "${name}"`,
      after: { name, phone: input.phone, openingBalance: opening },
    });
  })();

  const created = findCustomerById(db, id);
  if (!created) throw new AppError('internal', 'The customer could not be saved.');
  return created;
}

export function saveCustomer(
  db: BetterSqlite3.Database,
  input: SaveCustomerInput & { id: string },
  userId: string,
): CustomerRecord {
  const existing = findCustomerById(db, input.id);
  if (!existing) throw new AppError('not_found', 'That customer no longer exists.');

  const name = input.name.trim();
  if (name.length < 2) throw new AppError('invalid_name', 'Enter the customer’s name.');

  db.transaction(() => {
    updateCustomer(db, {
      id: input.id,
      name,
      phone: normalisePhone(input.phone),
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      isActive: input.isActive ?? existing.isActive,
    });
    writeAudit(db, {
      userId,
      action: 'customer.update',
      entity: 'customer',
      entityId: input.id,
      summary: `Edited customer "${name}"`,
      before: existing,
      after: { name, phone: input.phone },
    });
  })();

  const saved = findCustomerById(db, input.id);
  if (!saved) throw new AppError('internal', 'The customer could not be saved.');
  return saved;
}

/**
 * Remove a customer.
 *
 * Anyone with ledger history is deactivated instead of deleted — their entries
 * are the evidence behind past bills and settled debts.
 */
export function removeCustomer(
  db: BetterSqlite3.Database,
  id: string,
  userId: string,
): { deleted: boolean } {
  const customer = findCustomerById(db, id);
  if (!customer) throw new AppError('not_found', 'That customer no longer exists.');

  if (customer.balance !== 0) {
    throw new AppError(
      'balance_outstanding',
      'This customer still has a balance. Settle it before removing them.',
    );
  }

  const hasHistory = customerHasHistory(db, id);

  db.transaction(() => {
    if (hasHistory) {
      updateCustomer(db, {
        id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        notes: customer.notes,
        isActive: false,
      });
    } else {
      softDeleteCustomer(db, id);
    }
    writeAudit(db, {
      userId,
      action: hasHistory ? 'customer.deactivate' : 'customer.delete',
      entity: 'customer',
      entityId: id,
      summary: hasHistory
        ? `Deactivated customer "${customer.name}" (kept for their past bills)`
        : `Deleted customer "${customer.name}"`,
      before: customer,
    });
  })();

  return { deleted: !hasHistory };
}

export interface ReceivePaymentInput {
  customerId: string;
  amount: number;
  method: SettledMethod;
  note?: string | null;
}

/** Record money received against a customer's balance. */
export function receivePayment(
  db: BetterSqlite3.Database,
  input: ReceivePaymentInput,
  userId: string,
): { balanceAfter: number } {
  const amount = Math.round(input.amount);
  if (amount <= 0) throw new AppError('invalid_amount', 'Enter the amount received.');

  const customer = findCustomerById(db, input.customerId);
  if (!customer) throw new AppError('not_found', 'That customer no longer exists.');

  return db.transaction(() => {
    const timestamp = nowIso();
    const paymentId = uuidv7();

    db.prepare(
      `INSERT INTO customer_payments
         (id, customer_id, amount, method, received_at, user_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      paymentId,
      input.customerId,
      amount,
      input.method,
      timestamp,
      userId,
      input.note?.trim() || null,
      timestamp,
      timestamp,
    );

    const { balanceAfter } = appendLedgerEntry(db, {
      customerId: input.customerId,
      type: 'payment',
      amount,
      refType: 'payment',
      refId: paymentId,
      note: input.note?.trim() || null,
      userId,
    });

    writeAudit(db, {
      userId,
      action: 'customer.payment',
      entity: 'customer',
      entityId: input.customerId,
      summary: `Received payment from ${customer.name}`,
      after: { amount, method: input.method, balanceAfter },
    });

    return { balanceAfter };
  })();
}

/** Correct a balance by hand, with a reason. Admin-only at the op layer. */
export function adjustBalance(
  db: BetterSqlite3.Database,
  customerId: string,
  amount: number,
  note: string,
  userId: string,
): { balanceAfter: number } {
  const rounded = Math.round(amount);
  if (rounded === 0) throw new AppError('invalid_amount', 'Enter an amount to adjust by.');
  if (!note.trim()) throw new AppError('reason_required', 'Explain why this adjustment is needed.');

  const customer = findCustomerById(db, customerId);
  if (!customer) throw new AppError('not_found', 'That customer no longer exists.');

  return db.transaction(() => {
    const { balanceAfter } = appendLedgerEntry(db, {
      customerId,
      type: 'adjustment',
      amount: rounded,
      note: note.trim(),
      userId,
    });
    writeAudit(db, {
      userId,
      action: 'customer.adjust',
      entity: 'customer',
      entityId: customerId,
      summary: `Adjusted ${customer.name}'s balance`,
      before: { balance: customer.balance },
      after: { balance: balanceAfter, amount: rounded, note: note.trim() },
    });
    return { balanceAfter };
  })();
}

export interface LedgerRow {
  id: string;
  type: LedgerEntryType;
  amount: number;
  balanceAfter: number;
  refType: string | null;
  refId: string | null;
  refLabel: string | null;
  note: string | null;
  userName: string;
  entryDate: string;
  createdAt: string;
}

/** A customer's full history, oldest first so the running balance reads downward. */
export function customerLedger(db: BetterSqlite3.Database, customerId: string): LedgerRow[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.type, e.amount, e.balance_after, e.ref_type, e.ref_id, e.ref_label,
              e.note, e.entry_date, e.created_at,
              COALESCE(u.full_name, 'Deleted user') AS user_name
         FROM customer_ledger_entries e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.customer_id = ? AND e.deleted_at IS NULL
        ORDER BY e.entry_date, e.created_at`,
    )
    .all(customerId) as Array<{
    id: string;
    type: LedgerEntryType;
    amount: number;
    balance_after: number;
    ref_type: string | null;
    ref_id: string | null;
    ref_label: string | null;
    note: string | null;
    user_name: string;
    entry_date: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balance_after,
    refType: row.ref_type,
    refId: row.ref_id,
    refLabel: row.ref_label,
    note: row.note,
    userName: row.user_name,
    entryDate: row.entry_date,
    createdAt: row.created_at,
  }));
}

export interface LedgerMismatch {
  customerId: string;
  name: string;
  cached: number;
  fromEntries: number;
  firstBadEntryIndex: number | null;
}

/**
 * Check every customer's cached balance against their entries.
 *
 * Powers "check customer balances" in Settings. A dues report nobody can verify
 * is just a number on a screen.
 */
export function findLedgerMismatches(db: BetterSqlite3.Database): LedgerMismatch[] {
  const customers = db
    .prepare(`SELECT id, name, balance FROM customers WHERE deleted_at IS NULL`)
    .all() as Array<{ id: string; name: string; balance: number }>;

  const mismatches: LedgerMismatch[] = [];

  for (const customer of customers) {
    const entries = db
      .prepare(
        `SELECT amount, balance_after FROM customer_ledger_entries
          WHERE customer_id = ? AND deleted_at IS NULL
          ORDER BY entry_date, created_at`,
      )
      .all(customer.id) as Array<{ amount: number; balance_after: number }>;

    const check = verifyLedger(
      entries.map((entry) => ({ amount: entry.amount, balanceAfter: entry.balance_after })),
    );

    if (!check.ok || check.computed !== customer.balance) {
      mismatches.push({
        customerId: customer.id,
        name: customer.name,
        cached: customer.balance,
        fromEntries: check.computed,
        firstBadEntryIndex: check.firstMismatchIndex,
      });
    }
  }

  return mismatches;
}

function normalisePhone(phone: string | null | undefined): string | null {
  const trimmed = phone?.trim();
  return trimmed ? trimmed.replace(/[^\d+\s-]/g, '') : null;
}
