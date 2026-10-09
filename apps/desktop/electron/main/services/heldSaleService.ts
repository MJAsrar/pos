import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7 } from '@pos/shared';
import { AppError } from '../errors.js';

/**
 * Bills parked mid-sale.
 *
 * A customer decides to go and fetch their wallet while three people wait
 * behind them; the counter has to serve the queue and come back. The parked
 * bill is stored as opaque JSON — it is a draft, not a transaction, so it takes
 * no invoice number, moves no stock and touches no ledger until it is paid.
 *
 * Local only. These never sync: an unfinished bill on one machine is nobody
 * else's business.
 */

export interface HeldSaleRecord {
  id: string;
  label: string;
  userId: string;
  userName: string;
  payloadJson: string;
  createdAt: string;
}

const MAX_HELD_PER_USER = 20;

export function holdSale(
  db: BetterSqlite3.Database,
  label: string,
  payloadJson: string,
  userId: string,
): HeldSaleRecord {
  const trimmed = label.trim() || 'Parked bill';

  const count = db
    .prepare(`SELECT COUNT(*) AS count FROM held_sales WHERE user_id = ?`)
    .get(userId) as { count: number };
  if (count.count >= MAX_HELD_PER_USER) {
    throw new AppError(
      'too_many_held',
      `You already have ${MAX_HELD_PER_USER} parked bills. Finish or discard some first.`,
    );
  }

  const id = uuidv7();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO held_sales (id, label, user_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, trimmed, userId, payloadJson, createdAt);

  return { id, label: trimmed, userId, userName: '', payloadJson, createdAt };
}

/** Parked bills belonging to one person. */
export function listHeldSales(db: BetterSqlite3.Database, userId: string): HeldSaleRecord[] {
  const rows = db
    .prepare(
      `SELECT h.*, COALESCE(u.full_name, 'Deleted user') AS user_name
         FROM held_sales h
         LEFT JOIN users u ON u.id = h.user_id
        WHERE h.user_id = ?
        ORDER BY h.created_at DESC`,
    )
    .all(userId) as Array<{
    id: string;
    label: string;
    user_id: string;
    user_name: string;
    payload_json: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    userId: row.user_id,
    userName: row.user_name,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  }));
}

/**
 * Take a parked bill back to the counter.
 *
 * Reading it removes it, so the same draft cannot be recalled onto two screens
 * and rung up twice.
 */
export function recallHeldSale(
  db: BetterSqlite3.Database,
  id: string,
  userId: string,
): HeldSaleRecord {
  const row = db
    .prepare(`SELECT * FROM held_sales WHERE id = ? AND user_id = ?`)
    .get(id, userId) as
    | { id: string; label: string; user_id: string; payload_json: string; created_at: string }
    | undefined;

  if (!row) throw new AppError('not_found', 'That parked bill is no longer there.');

  db.prepare(`DELETE FROM held_sales WHERE id = ?`).run(id);

  return {
    id: row.id,
    label: row.label,
    userId: row.user_id,
    userName: '',
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

export function discardHeldSale(db: BetterSqlite3.Database, id: string, userId: string): void {
  const result = db.prepare(`DELETE FROM held_sales WHERE id = ? AND user_id = ?`).run(id, userId);
  if (result.changes === 0) throw new AppError('not_found', 'That parked bill is no longer there.');
}
