import type { Permission, Role } from '@pos/shared';

/**
 * Who is currently logged in at the counter.
 *
 * This lives in the main process, not the renderer. The renderer is told who the
 * user is so it can show the right screens, but that copy is only a hint — every
 * permission decision is made here, against this value, where page JavaScript
 * cannot reach it.
 */
export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  isActive: boolean;
}

let currentUser: SessionUser | null = null;
let loggedInAt: string | null = null;

export function setSessionUser(user: SessionUser, at: string): void {
  currentUser = user;
  loggedInAt = at;
}

export function getSessionUser(): SessionUser | null {
  return currentUser;
}

/** The logged-in user, or an error — for handlers that cannot run without one. */
export function requireSessionUser(): SessionUser {
  if (!currentUser) throw new AuthRequiredError();
  return currentUser;
}

export function clearSession(): void {
  currentUser = null;
  loggedInAt = null;
}

export function sessionStartedAt(): string | null {
  return loggedInAt;
}

/**
 * Refresh the cached session after an admin edits the logged-in user.
 *
 * Without this, revoking your own permission would not take effect until the
 * next login, which makes the Users screen quietly lie about what it changed.
 */
export function refreshSessionUser(user: SessionUser): void {
  if (currentUser?.id === user.id) currentUser = user;
}

export class AuthRequiredError extends Error {
  constructor() {
    super('You are not signed in.');
    this.name = 'AuthRequiredError';
  }
}
