import type BetterSqlite3 from 'better-sqlite3';
import { nowIso, sanitizePermissions, type Permission, type Role } from '@pos/shared';

/**
 * All SQL touching `users` lives here.
 *
 * Keeping queries in repositories rather than scattered through services is what
 * lets Stage 2 mirror these tables to Postgres without rewriting business logic.
 */

export interface UserRow {
  id: string;
  username: string;
  full_name: string;
  pin_hash: string;
  role: Role;
  permissions_json: string;
  is_active: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface UserRecord {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  isActive: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    permissions: parsePermissions(row.permissions_json),
    isActive: row.is_active === 1,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePermissions(json: string): Permission[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? sanitizePermissions(parsed) : [];
  } catch {
    // A corrupted permission list must not grant access; fall back to none.
    return [];
  }
}

const SELECT = `SELECT * FROM users WHERE deleted_at IS NULL`;

export function listUsers(db: BetterSqlite3.Database): UserRecord[] {
  const rows = db.prepare(`${SELECT} ORDER BY role = 'admin' DESC, full_name`).all() as UserRow[];
  return rows.map(mapUser);
}

/** Active users only — what the login screen offers. */
export function listActiveUsers(db: BetterSqlite3.Database): UserRecord[] {
  return listUsers(db).filter((user) => user.isActive);
}

export function findUserById(db: BetterSqlite3.Database, id: string): UserRecord | null {
  const row = db.prepare(`${SELECT} AND id = ?`).get(id) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function findUserRowById(db: BetterSqlite3.Database, id: string): UserRow | null {
  return (db.prepare(`${SELECT} AND id = ?`).get(id) as UserRow | undefined) ?? null;
}

export function findUserByUsername(db: BetterSqlite3.Database, username: string): UserRow | null {
  const row = db.prepare(`${SELECT} AND username = ? COLLATE NOCASE`).get(username) as
    | UserRow
    | undefined;
  return row ?? null;
}

export function countUsers(db: BetterSqlite3.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL`).get() as {
    count: number;
  };
  return row.count;
}

export function countAdmins(db: BetterSqlite3.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM users
       WHERE deleted_at IS NULL AND is_active = 1 AND role = 'admin'`,
    )
    .get() as { count: number };
  return row.count;
}

export interface InsertUserInput {
  id: string;
  username: string;
  fullName: string;
  pinHash: string;
  role: Role;
  permissions: Permission[];
}

export function insertUser(db: BetterSqlite3.Database, input: InsertUserInput): void {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO users
       (id, username, full_name, pin_hash, role, permissions_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    input.id,
    input.username,
    input.fullName,
    input.pinHash,
    input.role,
    JSON.stringify(input.permissions),
    timestamp,
    timestamp,
  );
}

export interface UpdateUserInput {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  isActive: boolean;
}

export function updateUser(db: BetterSqlite3.Database, input: UpdateUserInput): void {
  db.prepare(
    `UPDATE users
        SET username = ?, full_name = ?, role = ?, permissions_json = ?,
            is_active = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    input.username,
    input.fullName,
    input.role,
    JSON.stringify(input.permissions),
    input.isActive ? 1 : 0,
    nowIso(),
    input.id,
  );
}

export function updatePinHash(db: BetterSqlite3.Database, id: string, pinHash: string): void {
  db.prepare(
    `UPDATE users
        SET pin_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(pinHash, nowIso(), id);
}

export function softDeleteUser(db: BetterSqlite3.Database, id: string): void {
  const timestamp = nowIso();
  db.prepare(
    `UPDATE users SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?`,
  ).run(timestamp, timestamp, id);
}

export function recordLoginSuccess(db: BetterSqlite3.Database, id: string, at: string): void {
  db.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`,
  ).run(at, id);
}

export function recordLoginFailure(
  db: BetterSqlite3.Database,
  id: string,
  lockedUntil: string | null,
): void {
  db.prepare(
    `UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = ? WHERE id = ?`,
  ).run(lockedUntil, id);
}
