import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { can as canDo, type Permission } from '@pos/shared';
import type { SessionUser } from './api';

interface SessionContextValue {
  user: SessionUser;
  /** Whether the signed-in user may do something. */
  can: (permission: Permission) => boolean;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  user,
  signOut,
  children,
}: {
  user: SessionUser;
  signOut: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      can: (permission) => canDo(user, permission),
      signOut,
    }),
    [user, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * The signed-in user.
 *
 * `can()` here decides what the screen shows. It is not what decides whether an
 * action is allowed — the main process checks the same permission again before
 * touching the database, because anything in this process can be tampered with.
 */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
