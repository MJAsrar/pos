import type BetterSqlite3 from 'better-sqlite3';
import { nowIso } from '@pos/shared';

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  opening_balance: number;
  balance: number;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerRecord {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  openingBalance: number;
  /** Positive means the customer owes the shop. */
  balance: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function mapCustomer(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    openingBalance: row.opening_balance,
    balance: row.balance,
    notes: row.notes,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT * FROM customers WHERE deleted_at IS NULL`;

export interface ListCustomersOptions {
  search?: string;
  /** Only those who currently owe money — the dues list. */
  withDuesOnly?: boolean;
  includeInactive?: boolean;
}

export function listCustomers(
  db: BetterSqlite3.Database,
  options: ListCustomersOptions = {},
): CustomerRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!options.includeInactive) where.push('is_active = 1');
  if (options.withDuesOnly) where.push('balance > 0');
  if (options.search?.trim()) {
    where.push('(name LIKE ? COLLATE NOCASE OR phone LIKE ?)');
    const pattern = `%${options.search.trim()}%`;
    params.push(pattern, pattern);
  }

  const clause = where.length ? ` AND ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`${SELECT}${clause} ORDER BY balance DESC, name`)
    .all(...params) as CustomerRow[];
  return rows.map(mapCustomer);
}

export function findCustomerById(db: BetterSqlite3.Database, id: string): CustomerRecord | null {
  const row = db.prepare(`${SELECT} AND id = ?`).get(id) as CustomerRow | undefined;
  return row ? mapCustomer(row) : null;
}

export interface InsertCustomerInput {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  openingBalance: number;
  notes: string | null;
}

export function insertCustomer(db: BetterSqlite3.Database, input: InsertCustomerInput): void {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO customers
       (id, name, phone, address, opening_balance, balance, notes, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.phone,
    input.address,
    input.openingBalance,
    input.notes,
    timestamp,
    timestamp,
  );
}

export interface UpdateCustomerInput {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
}

/** Update details only. The balance moves by writing a ledger entry, never here. */
export function updateCustomer(db: BetterSqlite3.Database, input: UpdateCustomerInput): void {
  db.prepare(
    `UPDATE customers
        SET name = ?, phone = ?, address = ?, notes = ?, is_active = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    input.name,
    input.phone,
    input.address,
    input.notes,
    input.isActive ? 1 : 0,
    nowIso(),
    input.id,
  );
}

export function softDeleteCustomer(db: BetterSqlite3.Database, id: string): void {
  const timestamp = nowIso();
  db.prepare(
    `UPDATE customers SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?`,
  ).run(timestamp, timestamp, id);
}

export function customerHasHistory(db: BetterSqlite3.Database, id: string): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM customer_ledger_entries WHERE customer_id = ? AND deleted_at IS NULL
       ) AS used`,
    )
    .get(id) as { used: number };
  return row.used === 1;
}

/** Totals for the dues report header. */
export function duesSummary(db: BetterSqlite3.Database): {
  owedToShop: number;
  advances: number;
  customersOwing: number;
} {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN balance > 0 THEN balance END), 0) AS owed,
              COALESCE(-SUM(CASE WHEN balance < 0 THEN balance END), 0) AS advances,
              COUNT(*) FILTER (WHERE balance > 0) AS owing
         FROM customers
        WHERE deleted_at IS NULL`,
    )
    .get() as { owed: number; advances: number; owing: number };

  return { owedToShop: row.owed, advances: row.advances, customersOwing: row.owing };
}
