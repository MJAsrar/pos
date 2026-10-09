import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, uuidv7 } from '@pos/shared';

/**
 * The audit log.
 *
 * Anything that changes money, stock or access gets a row here: price overrides
 * at the counter, voided bills, stock adjustments, permission changes. The point
 * is that when a figure looks wrong a week later, the owner can see who did what
 * rather than having to trust a recollection.
 *
 * `writeAudit` never opens its own transaction. It is always called from inside
 * the transaction of the thing it describes, so a rolled-back sale cannot leave
 * an audit row claiming it happened.
 */

export interface AuditInput {
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

export function writeAudit(db: BetterSqlite3.Database, input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_log
       (id, user_id, action, entity, entity_id, summary, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(),
    input.userId,
    input.action,
    input.entity,
    input.entityId,
    input.summary,
    serialise(input.before),
    serialise(input.after),
    nowIso(),
  );
}

function serialise(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export interface AuditQuery {
  entity?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: string;
}

export function listAudit(db: BetterSqlite3.Database, query: AuditQuery = {}): AuditRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.entity) {
    where.push('a.entity = ?');
    params.push(query.entity);
  }
  if (query.entityId) {
    where.push('a.entity_id = ?');
    params.push(query.entityId);
  }
  if (query.userId) {
    where.push('a.user_id = ?');
    params.push(query.userId);
  }
  if (query.action) {
    where.push('a.action = ?');
    params.push(query.action);
  }
  if (query.from) {
    where.push('a.created_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('a.created_at < ?');
    params.push(query.to);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT a.id, a.user_id, a.action, a.entity, a.entity_id, a.summary,
              a.before_json, a.after_json, a.created_at,
              COALESCE(u.full_name, 'Deleted user') AS user_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         ${clause}
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{
    id: string;
    user_id: string;
    user_name: string;
    action: string;
    entity: string;
    entity_id: string;
    summary: string;
    before_json: string | null;
    after_json: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    summary: row.summary,
    beforeJson: row.before_json,
    afterJson: row.after_json,
    createdAt: row.created_at,
  }));
}
