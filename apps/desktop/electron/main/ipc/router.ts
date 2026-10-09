import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import {
  PermissionDeniedError,
  SyncAuthError,
  SyncServerError,
  can,
  type Permission,
} from '@pos/shared';
import { getDb } from '../db/connection.js';
import { AppError } from '../errors.js';
import { AuthRequiredError, getSessionUser, type SessionUser } from '../session.js';

/**
 * The single door between the renderer and the shop's data.
 *
 * Every operation declares the shape of its input and the permission it needs.
 * The router validates and authorises before the handler ever runs, so a staff
 * account cannot read cost prices by calling the op directly from devtools —
 * hiding the column in the UI is presentation, this is the actual boundary.
 */

export interface OpContext {
  db: BetterSqlite3.Database;
  /** Null only for operations marked `public`. */
  user: SessionUser;
}

export interface PublicOpContext {
  db: BetterSqlite3.Database;
  user: SessionUser | null;
}

interface BaseOp {
  op: string;
  /** Skip the signed-in check. Login and first-run setup need this; nothing else should. */
  public?: boolean;
  permission?: Permission;
}

export interface AuthedOpDefinition<Schema extends z.ZodType, Result> extends BaseOp {
  public?: false;
  input: Schema;
  handler: (input: z.output<Schema>, ctx: OpContext) => Result | Promise<Result>;
}

export interface PublicOpDefinition<Schema extends z.ZodType, Result> extends BaseOp {
  public: true;
  input: Schema;
  handler: (input: z.output<Schema>, ctx: PublicOpContext) => Result | Promise<Result>;
}

type AnyOpDefinition =
  | AuthedOpDefinition<z.ZodType, unknown>
  | PublicOpDefinition<z.ZodType, unknown>;

const registry = new Map<string, AnyOpDefinition>();

export function defineOp<Schema extends z.ZodType, Result>(
  definition: AuthedOpDefinition<Schema, Result> | PublicOpDefinition<Schema, Result>,
): void {
  if (registry.has(definition.op)) {
    throw new Error(`Duplicate operation registered: ${definition.op}`);
  }
  registry.set(definition.op, definition as AnyOpDefinition);
}

export function registerOps(definitions: readonly unknown[]): void {
  for (const definition of definitions) defineOp(definition as AuthedOpDefinition<z.ZodType, unknown>);
}

export function registeredOps(): string[] {
  return [...registry.keys()].sort();
}

/** Error shape the renderer receives. Never carries a stack trace. */
export interface OpError {
  code: string;
  message: string;
  /** Field-level problems from input validation, for form display. */
  fields?: Record<string, string>;
}

export type OpResult<T> = { ok: true; data: T } | { ok: false; error: OpError };

export { AppError };

/**
 * Run an operation.
 *
 * Errors are returned rather than thrown: an exception crossing the IPC boundary
 * arrives in the renderer as a mangled string, which makes a failed sale look
 * like a bug in the app rather than "this item has no stock".
 */
export async function callOp(op: unknown, payload: unknown): Promise<OpResult<unknown>> {
  try {
    if (typeof op !== 'string') {
      return fail('bad_request', 'Malformed request.');
    }

    const definition = registry.get(op);
    if (!definition) {
      return fail('unknown_op', `Unknown operation: ${op}`);
    }

    const user = getSessionUser();

    if (!definition.public && !user) {
      throw new AuthRequiredError();
    }
    if (definition.permission && !can(user, definition.permission)) {
      throw new PermissionDeniedError(definition.permission);
    }

    const parsed = definition.input.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: validationError(parsed.error) };
    }

    const context = { db: getDb(), user } as OpContext & PublicOpContext;
    const data = await definition.handler(parsed.data, context);
    return { ok: true, data };
  } catch (cause) {
    return { ok: false, error: toOpError(cause) };
  }
}

function fail(code: string, message: string): OpResult<never> {
  return { ok: false, error: { code, message } };
}

function validationError(error: z.ZodError): OpError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return {
    code: 'invalid_input',
    message: 'Some of the details entered are not valid.',
    fields,
  };
}

function toOpError(cause: unknown): OpError {
  if (cause instanceof AppError) {
    return { code: cause.code, message: cause.message };
  }
  if (cause instanceof PermissionDeniedError) {
    return { code: 'permission_denied', message: cause.message };
  }
  if (cause instanceof AuthRequiredError) {
    return { code: 'auth_required', message: cause.message };
  }
  // Both already say what went wrong and what to do about it, in the shop's
  // own words. Falling through to the generic handler below would bury that
  // under "Something went wrong", which tells a person nothing.
  if (cause instanceof SyncAuthError) {
    return { code: 'cloud_sign_in', message: cause.message };
  }
  if (cause instanceof SyncServerError) {
    return { code: 'cloud_refused', message: cause.message };
  }
  if (cause instanceof Error) {
    // Unexpected: log the real detail here, hand the renderer something calm.
    console.error('[ipc] unhandled error:', cause);
    return {
      code: 'internal',
      message: `Something went wrong: ${cause.message}`,
    };
  }
  console.error('[ipc] unhandled non-error throw:', cause);
  return { code: 'internal', message: 'Something went wrong.' };
}
