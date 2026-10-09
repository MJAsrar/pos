import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7 } from '@pos/shared';
import { AppError } from '../errors.js';
import { writeAudit } from './auditService.js';

/**
 * Shop expenses.
 *
 * Without these, a profit report shows margin on goods and calls it profit. The
 * owner wants to know what is actually left at the end of the day, which means
 * rent, electricity, tea and transport have to be in the same picture.
 */

/** Offered on the expense screen; the field accepts anything typed. */
export const COMMON_EXPENSE_CATEGORIES = [
  'Rent',
  'Electricity',
  'Staff wages',
  'Transport',
  'Tea & food',
  'Repairs',
  'Packaging',
  'Other',
] as const;

export interface ExpenseRecord {
  id: string;
  category: string;
  description: string | null;
  amount: number;
  spentAt: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface SaveExpenseInput {
  id?: string;
  category: string;
  description?: string | null;
  amount: number;
  spentAt: string;
}

export function saveExpense(
  db: BetterSqlite3.Database,
  input: SaveExpenseInput,
  userId: string,
): ExpenseRecord {
  const category = input.category.trim();
  const amount = Math.round(input.amount);

  if (category.length < 2) throw new AppError('invalid_category', 'Choose what this expense was for.');
  if (amount <= 0) throw new AppError('invalid_amount', 'Enter the amount spent.');

  const id = input.id ?? uuidv7();
  const timestamp = nowIso();
  const existing = input.id ? findExpenseById(db, input.id) : null;

  if (input.id && !existing) throw new AppError('not_found', 'That expense no longer exists.');

  db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE expenses
            SET category = ?, description = ?, amount = ?, spent_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      ).run(category, input.description?.trim() || null, amount, input.spentAt, timestamp, id);
    } else {
      db.prepare(
        `INSERT INTO expenses
           (id, category, description, amount, spent_at, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, category, input.description?.trim() || null, amount, input.spentAt, userId, timestamp, timestamp);
    }

    writeAudit(db, {
      userId,
      action: existing ? 'expense.update' : 'expense.create',
      entity: 'expense',
      entityId: id,
      summary: `${existing ? 'Edited' : 'Recorded'} ${category} expense`,
      before: existing,
      after: { category, amount, spentAt: input.spentAt },
    });
  })();

  const saved = findExpenseById(db, id);
  if (!saved) throw new AppError('internal', 'The expense could not be saved.');
  return saved;
}

export function removeExpense(db: BetterSqlite3.Database, id: string, userId: string): void {
  const existing = findExpenseById(db, id);
  if (!existing) throw new AppError('not_found', 'That expense no longer exists.');

  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(
      timestamp,
      timestamp,
      id,
    );
    writeAudit(db, {
      userId,
      action: 'expense.delete',
      entity: 'expense',
      entityId: id,
      summary: `Deleted ${existing.category} expense`,
      before: existing,
    });
  })();
}

export function findExpenseById(db: BetterSqlite3.Database, id: string): ExpenseRecord | null {
  const row = db
    .prepare(
      `SELECT e.*, COALESCE(u.full_name, 'Deleted user') AS user_name
         FROM expenses e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id = ? AND e.deleted_at IS NULL`,
    )
    .get(id) as ExpenseRow | undefined;
  return row ? mapExpense(row) : null;
}

export function listExpenses(
  db: BetterSqlite3.Database,
  options: { from?: string; to?: string; category?: string; limit?: number } = {},
): ExpenseRecord[] {
  const where = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (options.from) {
    where.push('e.spent_at >= ?');
    params.push(options.from);
  }
  if (options.to) {
    where.push('e.spent_at <= ?');
    params.push(options.to);
  }
  if (options.category) {
    where.push('e.category = ?');
    params.push(options.category);
  }

  const rows = db
    .prepare(
      `SELECT e.*, COALESCE(u.full_name, 'Deleted user') AS user_name
         FROM expenses e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.spent_at DESC, e.created_at DESC
        LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(options.limit ?? 200, 1), 1000)) as ExpenseRow[];

  return rows.map(mapExpense);
}

/** Total spent in a date range, for the profit report. */
export function expensesTotal(db: BetterSqlite3.Database, from: string, to: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
        WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at <= ?`,
    )
    .get(from, to) as { total: number };
  return row.total;
}

export function expensesByCategory(
  db: BetterSqlite3.Database,
  from: string,
  to: string,
): Array<{ category: string; total: number }> {
  return db
    .prepare(
      `SELECT category, SUM(amount) AS total FROM expenses
        WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at <= ?
        GROUP BY category
        ORDER BY total DESC`,
    )
    .all(from, to) as Array<{ category: string; total: number }>;
}

interface ExpenseRow {
  id: string;
  category: string;
  description: string | null;
  amount: number;
  spent_at: string;
  user_id: string;
  user_name: string;
  created_at: string;
}

function mapExpense(row: ExpenseRow): ExpenseRecord {
  return {
    id: row.id,
    category: row.category,
    description: row.description,
    amount: row.amount,
    spentAt: row.spent_at,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: row.created_at,
  };
}
