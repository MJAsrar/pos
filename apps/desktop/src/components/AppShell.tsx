import { useEffect, useState, type ReactNode } from 'react';
import { formatDateTime, type Permission } from '@pos/shared';
import { useSession } from '@/lib/session';
import { SyncPill } from '@/components/SyncPill';

export type ScreenId =
  | 'billing'
  | 'bills'
  | 'items'
  | 'customers'
  | 'expenses'
  | 'reports'
  | 'activity'
  | 'users'
  | 'settings';

interface NavEntry {
  id: ScreenId;
  label: string;
  /** Omitted for screens every signed-in user may open. */
  permission?: Permission;
}

const NAV: readonly NavEntry[] = [
  { id: 'billing', label: 'New sale', permission: 'sale.create' },
  { id: 'bills', label: 'Bills' },
  { id: 'customers', label: 'Customers' },
  { id: 'items', label: 'Items', permission: 'item.manage' },
  { id: 'expenses', label: 'Expenses', permission: 'expense.manage' },
  { id: 'reports', label: 'Reports', permission: 'report.view' },
  { id: 'activity', label: 'Activity', permission: 'audit.view' },
  { id: 'users', label: 'Users', permission: 'user.manage' },
  { id: 'settings', label: 'Settings', permission: 'settings.manage' },
];

interface AppShellProps {
  shopName: string;
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  children: ReactNode;
}

/**
 * The frame around every screen.
 *
 * The rail is the edge of the counter: the shop's name, where you are, and who
 * is signed in — all fixed in place while the work happens to the right of it.
 */
export function AppShell({ shopName, screen, onNavigate, children }: AppShellProps): React.JSX.Element {
  const { user, can, signOut } = useSession();
  const visible = NAV.filter((entry) => !entry.permission || can(entry.permission));

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col bg-ink text-white">
        <div className="px-5 pb-5 pt-6">
          <p className="text-row font-semibold leading-snug tracking-tight">{shopName}</p>
          <Clock />
        </div>

        <ul className="flex-1 px-2.5">
          {visible.map((entry) => {
            const active = entry.id === screen;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(entry.id)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'mb-0.5 w-full rounded px-2.5 py-2 text-left text-base transition-colors duration-100',
                    active
                      ? 'bg-board font-medium text-white'
                      : 'text-white/65 hover:bg-white/8 hover:text-white',
                  ].join(' ')}
                >
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ul>

        <SyncPill />

        <div className="border-t border-white/10 p-4">
          <p className="text-base font-medium">{user.fullName}</p>
          <p className="text-meta text-white/45">{user.role === 'admin' ? 'Owner' : 'Staff'}</p>
          <button
            type="button"
            onClick={signOut}
            className="mt-2.5 text-meta text-white/55 underline-offset-2 transition-colors duration-100 hover:text-white hover:underline"
          >
            Sign out
          </button>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col bg-paper">{children}</main>
    </div>
  );
}

/**
 * The date and time, kept current.
 *
 * The machine runs for weeks without being restarted, so a timestamp rendered
 * once at boot would quietly be wrong by the afternoon.
 */
function Clock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <p className="mt-2 text-meta text-white/45">{formatDateTime(now)}</p>
  );
}
