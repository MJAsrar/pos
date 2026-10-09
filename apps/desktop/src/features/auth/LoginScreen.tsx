import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDate } from '@pos/shared';
import { Button } from '@/components/Button';
import { PinPad } from '@/components/PinPad';
import { ApiError, api, type LoginOption, type Session } from '@/lib/api';

interface LoginScreenProps {
  shopName: string;
  onSignedIn: (session: Session) => void;
}

/**
 * Sign in at the counter.
 *
 * Pick a name, then type a PIN. Choosing the person first means one hash is
 * verified instead of every hash in the table, and it makes switching between
 * two people at a shared machine a two-second job.
 */
export function LoginScreen({ shopName, onSignedIn }: LoginScreenProps): React.JSX.Element {
  const [selected, setSelected] = useState<LoginOption | null>(null);
  const [pin, setPin] = useState('');

  const users = useQuery({ queryKey: ['auth.loginOptions'], queryFn: api.loginOptions });

  const signIn = useMutation({
    mutationFn: (entered: string) => api.login(selected!.id, entered),
    onSuccess: onSignedIn,
    onError: () => setPin(''),
  });

  const error = signIn.error instanceof ApiError ? signIn.error.message : undefined;

  function choose(user: LoginOption): void {
    signIn.reset();
    setPin('');
    setSelected(user);
  }

  return (
    <div className="flex h-full bg-paper">
      {/* The counter edge: shop identity stays put while people come and go. */}
      <aside className="flex w-80 flex-col justify-between bg-ink p-8 text-white">
        <div>
          <h1 className="text-title font-semibold leading-tight tracking-tight">{shopName}</h1>
          <p className="mt-2 text-meta text-white/55">{formatDate(new Date())}</p>
        </div>
        <p className="text-meta text-white/40">
          Every sale records who made it, so sign in as yourself.
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center p-10">
        {!selected ? (
          <div className="w-full max-w-md">
            <h2 className="text-section font-semibold text-ink">Who is at the counter?</h2>

            {users.isPending && <p className="mt-6 text-ink-soft">Loading…</p>}

            {users.isError && (
              <p className="mt-6 text-due">
                The user list could not be loaded. Close and reopen Al Hamza POS.
              </p>
            )}

            {users.data && users.data.length === 0 && (
              <p className="mt-6 text-ink-soft">
                No active accounts. Ask the owner to switch an account back on.
              </p>
            )}

            <ul className="mt-5 divide-y divide-rule border-y border-rule">
              {users.data?.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => choose(user)}
                    disabled={Boolean(user.lockedUntil)}
                    className="flex w-full items-center justify-between py-4 text-left transition-colors duration-100 hover:bg-surface disabled:cursor-not-allowed"
                  >
                    <span>
                      <span className="block text-row font-medium text-ink">{user.fullName}</span>
                      <span className="block text-meta text-ink-soft">
                        {user.role === 'admin' ? 'Owner' : 'Staff'}
                      </span>
                    </span>
                    {user.lockedUntil && (
                      <span className="rounded bg-due-tint px-2 py-1 text-meta font-medium text-due">
                        Locked
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="w-full max-w-xs">
            <h2 className="text-center text-section font-semibold text-ink">{selected.fullName}</h2>
            <p className="mb-7 mt-1 text-center text-meta text-ink-soft">Enter your PIN</p>

            <PinPad
              value={pin}
              onChange={setPin}
              onComplete={(entered) => signIn.mutate(entered)}
              disabled={signIn.isPending}
              error={error}
            />

            <Button onClick={() => setSelected(null)} className="mt-7 w-full" disabled={signIn.isPending}>
              {signIn.isPending ? 'Checking…' : 'Someone else'}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
