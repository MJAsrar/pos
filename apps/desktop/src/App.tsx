import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell, type ScreenId } from '@/components/AppShell';
import { ActivityScreen } from '@/features/activity/ActivityScreen';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { BillingScreen } from '@/features/billing/BillingScreen';
import { BillsScreen } from '@/features/bills/BillsScreen';
import { CustomersScreen } from '@/features/customers/CustomersScreen';
import { ExpensesScreen } from '@/features/expenses/ExpensesScreen';
import { ItemsScreen } from '@/features/items/ItemsScreen';
import { ReportsScreen } from '@/features/reports/ReportsScreen';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { SetupScreen } from '@/features/setup/SetupScreen';
import { UsersScreen } from '@/features/users/UsersScreen';
import { api, type Session } from '@/lib/api';
import { SessionProvider } from '@/lib/session';

/**
 * Decides which of the three states the app is in: never used before, signed
 * out, or at the counter. Everything past sign-in lives inside `AppShell`.
 */
export function App(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<ScreenId>('billing');

  const status = useQuery({ queryKey: ['app.status'], queryFn: api.appStatus });

  const signOut = useCallback(() => {
    void api.logout().finally(() => {
      setSession(null);
      setScreen('billing');
      queryClient.clear();
    });
  }, [queryClient]);

  const handleSignedIn = useCallback(
    (next: Session) => {
      setSession(next);
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  if (status.isPending) {
    return <Splash message="Starting Al Hamza POS…" />;
  }

  if (status.isError) {
    return (
      <Splash
        message="The application could not start."
        detail="Close Al Hamza POS and open it again. If this keeps happening, show this screen to whoever set up the system."
        tone="error"
      />
    );
  }

  const active = session ?? status.data.signedIn;

  if (status.data.needsSetup && !active) {
    return (
      <SetupScreen
        shopName={status.data.shopName}
        onDone={(next) => {
          handleSignedIn(next);
          void status.refetch();
        }}
      />
    );
  }

  if (!active) {
    return <LoginScreen shopName={status.data.shopName} onSignedIn={handleSignedIn} />;
  }

  return (
    <SessionProvider user={active.user} signOut={signOut}>
      <AppShell shopName={status.data.shopName} screen={screen} onNavigate={setScreen}>
        <Screen id={screen} />
      </AppShell>
    </SessionProvider>
  );
}

function Splash({
  message,
  detail,
  tone = 'normal',
}: {
  message: string;
  detail?: string;
  tone?: 'normal' | 'error';
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-paper px-10 text-center">
      <p className={tone === 'error' ? 'text-section text-due' : 'text-section text-ink-soft'}>
        {message}
      </p>
      {detail && <p className="max-w-md text-meta text-ink-soft">{detail}</p>}
    </div>
  );
}

/**
 * Each screen is mounted fresh when selected and unmounted when left.
 *
 * Deliberate: the billing screen owns a half-finished bill and a pile of
 * keyboard handlers, and neither should stay alive behind the reports page.
 */
function Screen({ id }: { id: ScreenId }): React.JSX.Element {
  switch (id) {
    case 'billing':
      return <BillingScreen />;
    case 'bills':
      return <BillsScreen />;
    case 'items':
      return <ItemsScreen />;
    case 'customers':
      return <CustomersScreen />;
    case 'expenses':
      return <ExpensesScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'activity':
      return <ActivityScreen />;
    case 'users':
      return <UsersScreen />;
    case 'settings':
      return <SettingsScreen />;
  }
}
