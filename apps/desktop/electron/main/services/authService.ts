import type BetterSqlite3 from 'better-sqlite3';
import { hash, verify } from '@node-rs/argon2';
import {
  DEFAULT_STAFF_PERMISSIONS,
  nowIso,
  sanitizePermissions,
  uuidv7,
  type Permission,
  type Role,
} from '@pos/shared';
import { AppError } from '../errors.js';
import {
  countAdmins,
  countUsers,
  findUserRowById,
  findUserByUsername,
  insertUser,
  listActiveUsers,
  mapUser,
  recordLoginFailure,
  recordLoginSuccess,
  updatePinHash,
  type UserRecord,
} from '../db/repos/userRepo.js';
import { clearSession, setSessionUser, type SessionUser } from '../session.js';
import { writeAudit } from './auditService.js';

/**
 * Login and PIN handling.
 *
 * Cashiers sign in with a 4-digit PIN, because at a counter a password is either
 * slow or written on the monitor. A 4-digit PIN is only 10,000 possibilities, so
 * two things compensate: the hash is Argon2id (deliberately slow to test), and
 * the account locks itself after repeated wrong guesses. Verification happens
 * here in the main process — the renderer never receives a hash.
 */

export const PIN_LENGTH = 4;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 5;

// Argon2id tuned so a single verify takes roughly 100ms on shop-grade hardware:
// unnoticeable when a cashier signs in, ruinous for anyone trying all 10,000 PINs.
// Argon2id is @node-rs/argon2's default algorithm. It is not named explicitly
// because the library exports `Algorithm` as an ambient const enum, which cannot
// be referenced under isolatedModules.
const ARGON_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** Reject PINs that offer no protection at all. */
export function pinWeakness(pin: string): string | null {
  if (!isValidPin(pin)) return `The PIN must be exactly ${PIN_LENGTH} digits.`;
  if (/^(\d)\1+$/.test(pin)) return 'Choose a PIN that is not the same digit repeated.';
  if (pin === '1234' || pin === '0000' || pin === '4321') {
    return 'That PIN is too easy to guess. Choose another.';
  }
  return null;
}

export async function hashPin(pin: string): Promise<string> {
  const weakness = pinWeakness(pin);
  if (weakness) throw new AppError('weak_pin', weakness);
  return hash(pin, ARGON_OPTIONS);
}

export interface LoginResult {
  user: SessionUser;
  loggedInAt: string;
}

/**
 * Sign a user in by PIN.
 *
 * The user is chosen from the list first and then enters their PIN, so this
 * verifies one hash rather than every hash in the table.
 */
export async function login(
  db: BetterSqlite3.Database,
  userId: string,
  pin: string,
): Promise<LoginResult> {
  const row = findUserRowById(db, userId);

  // Same message whether the user is missing, inactive or the PIN is wrong:
  // there is nothing to gain from telling the screen which it was.
  const genericFailure = () => new AppError('invalid_credentials', 'Wrong PIN. Try again.');

  if (!row || row.is_active !== 1) throw genericFailure();

  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const minutes = Math.max(
      1,
      Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60_000),
    );
    throw new AppError(
      'account_locked',
      `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, ` +
        `or ask the owner to reset the PIN.`,
    );
  }

  const matches = await verify(row.pin_hash, pin).catch(() => false);

  if (!matches) {
    const attempts = row.failed_attempts + 1;
    const lockedUntil =
      attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
        : null;
    recordLoginFailure(db, row.id, lockedUntil);

    if (lockedUntil) {
      throw new AppError(
        'account_locked',
        `Too many wrong PINs. This account is locked for ${LOCKOUT_MINUTES} minutes.`,
      );
    }
    const remaining = MAX_FAILED_ATTEMPTS - attempts;
    throw new AppError(
      'invalid_credentials',
      `Wrong PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} left before this account locks.`,
    );
  }

  const loggedInAt = nowIso();
  recordLoginSuccess(db, row.id, loggedInAt);

  const user = toSessionUser(mapUser(row));
  setSessionUser(user, loggedInAt);
  writeAudit(db, {
    userId: user.id,
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    summary: `${user.fullName} signed in`,
  });

  return { user, loggedInAt };
}

export function logout(): void {
  clearSession();
}

export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    permissions: user.permissions,
    isActive: user.isActive,
  };
}

export interface LoginOption {
  id: string;
  fullName: string;
  username: string;
  role: Role;
  /** So the login screen can explain a refusal before the PIN is typed. */
  lockedUntil: string | null;
}

/** The users the login screen shows. Carries no hashes and no permissions. */
export function loginOptions(db: BetterSqlite3.Database): LoginOption[] {
  return listActiveUsers(db).map((user) => ({
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    role: user.role,
    lockedUntil: user.lockedUntil && new Date(user.lockedUntil) > new Date() ? user.lockedUntil : null,
  }));
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  pin: string;
  role: Role;
  permissions?: Permission[];
}

/**
 * Create a user.
 *
 * Also used for first-run setup, where there is no signed-in admin yet — the op
 * layer is what decides whether that is allowed, by checking the table is empty.
 */
export async function createUser(
  db: BetterSqlite3.Database,
  input: CreateUserInput,
  actorId: string | null,
): Promise<UserRecord> {
  const username = input.username.trim().toLowerCase();
  const fullName = input.fullName.trim();

  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    throw new AppError(
      'invalid_username',
      'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.',
    );
  }
  if (fullName.length < 2) {
    throw new AppError('invalid_name', 'Enter the full name of this person.');
  }
  if (findUserByUsername(db, username)) {
    throw new AppError('username_taken', `The username "${username}" is already in use.`);
  }

  const pinHash = await hashPin(input.pin);
  const id = uuidv7();
  const permissions =
    input.role === 'admin'
      ? []
      : sanitizePermissions(input.permissions ?? [...DEFAULT_STAFF_PERMISSIONS]);

  db.transaction(() => {
    insertUser(db, { id, username, fullName, pinHash, role: input.role, permissions });
    writeAudit(db, {
      userId: actorId ?? id,
      action: 'user.create',
      entity: 'user',
      entityId: id,
      summary: `Created ${input.role} account "${fullName}"`,
      after: { username, fullName, role: input.role, permissions },
    });
  })();

  const created = findUserRowById(db, id);
  if (!created) throw new AppError('internal', 'The user could not be created.');
  return mapUser(created);
}

/** Change a user's PIN. The caller decides who is allowed to do this. */
export async function changePin(
  db: BetterSqlite3.Database,
  userId: string,
  newPin: string,
  actorId: string,
): Promise<void> {
  const target = findUserRowById(db, userId);
  if (!target) throw new AppError('not_found', 'That user no longer exists.');

  const pinHash = await hashPin(newPin);

  db.transaction(() => {
    updatePinHash(db, userId, pinHash);
    writeAudit(db, {
      userId: actorId,
      action: 'user.change_pin',
      entity: 'user',
      entityId: userId,
      summary:
        actorId === userId
          ? `${target.full_name} changed their own PIN`
          : `PIN reset for "${target.full_name}"`,
    });
  })();
}

/** True when the database has no users yet and first-run setup should appear. */
export function needsFirstRunSetup(db: BetterSqlite3.Database): boolean {
  return countUsers(db) === 0;
}

/** Guard against the shop locking itself out of its own admin account. */
export function assertNotLastAdmin(db: BetterSqlite3.Database, userId: string): void {
  const row = findUserRowById(db, userId);
  if (!row || row.role !== 'admin' || row.is_active !== 1) return;
  if (countAdmins(db) <= 1) {
    throw new AppError(
      'last_admin',
      'This is the only admin account. Create another admin before changing this one.',
    );
  }
}
