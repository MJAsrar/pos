import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ApiError, api } from '@/lib/api';

/**
 * Connecting the shop so it can be seen from a phone.
 *
 * Deliberately plain about what this is and is not. It is a copy the owner can
 * look at from anywhere, not a backup — a backup is the file on this computer,
 * and the section above handles that. Saying so here stops the one mistake
 * that would matter: trusting the cloud and never taking a real backup.
 *
 * Nothing here is required for the till to work. That is said out loud too,
 * because a shop that thinks selling needs the internet will stop selling the
 * first time the internet drops.
 */
export function CloudSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['syncStatus'], queryFn: api.syncStatus });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    void queryClient.invalidateQueries({ queryKey: ['syncConflicts'] });
  };

  const syncNow = useMutation({ mutationFn: api.syncNow, onSuccess: refresh });
  const signOut = useMutation({ mutationFn: api.cloudSignOut, onSuccess: refresh });
  const retry = useMutation({ mutationFn: api.retrySyncQueue, onSuccess: refresh });

  if (!status.data) return <p className="text-ink-soft">Loading…</p>;

  const state = status.data;
  const waiting = state.pending + state.failed;

  if (!state.configured) {
    return <SignIn onDone={refresh} />;
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-base">
        <Row label="Signed in as" value={state.account ?? '—'} />
        <Row
          label="Last saved online"
          value={state.lastSyncedAt ? formatDateTime(state.lastSyncedAt) : 'Not yet'}
        />
        <Row
          label="Waiting to go up"
          value={waiting === 0 ? 'Nothing — all through' : `${waiting}`}
        />
        {state.dead > 0 && <Row label="Could not be saved" value={`${state.dead}`} alarm />}
      </dl>

      {state.lastError && waiting > 0 && (
        <p className="rounded border border-rule bg-board/40 px-3 py-2.5 text-meta text-ink-soft">
          {state.lastError} Everything is safe on this computer; it will go up on its own when the
          internet is back.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending || state.busy}>
          {syncNow.isPending || state.busy ? 'Sending…' : 'Send now'}
        </Button>
        {state.dead > 0 && (
          <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
            Try the stuck changes again
          </Button>
        )}
        <Button variant="quiet" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Disconnect this computer
        </Button>
      </div>

      {syncNow.data?.problem && (
        <p className="text-meta text-due">{syncNow.data.problem}</p>
      )}
      {syncNow.data && !syncNow.data.problem && !syncNow.data.skipped && (
        <p className="text-meta text-ink-soft">
          Sent {syncNow.data.sent}, received {syncNow.data.received}.
        </p>
      )}

      <Overruled unseen={state.unseenConflicts} />
    </div>
  );
}

/** First-time connection. The password is used once and never stored. */
function SignIn({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => api.cloudSignIn(email.trim(), password),
    onSuccess: () => {
      setPassword('');
      onDone();
    },
  });

  const error = signIn.error instanceof ApiError ? signIn.error.message : undefined;

  return (
    <form
      className="max-w-sm space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (email.trim() && password) signIn.mutate();
      }}
    >
      <p className="text-meta text-ink-soft">
        Sign this computer in once, and the shop can be seen from a phone or laptop. The till works
        exactly the same whether this is set up or not.
      </p>

      <Field
        label="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="off"
        maxLength={200}
      />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="off"
        maxLength={200}
        hint="Used once to sign in. It is not kept on this computer."
      />

      {error && <p className="text-meta text-due">{error}</p>}

      <Button
        type="submit"
        variant="primary"
        disabled={signIn.isPending || !email.trim() || !password}
      >
        {signIn.isPending ? 'Connecting…' : 'Connect this computer'}
      </Button>
    </form>
  );
}

/**
 * Changes made here that were overruled by a change made elsewhere.
 *
 * Shown rather than hidden, because the owner repricing an item on their phone
 * while a staff member reprices it at the counter is a thing that will happen,
 * and the one who lost should be able to find out rather than wonder why the
 * price "went back".
 */
function Overruled({ unseen }: { unseen: number }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  // The count is part of the key on purpose. A clash can arrive while this
  // screen is open — it is exactly the screen someone watches when sync looks
  // wrong — and without this the list would stay as it was when the page
  // loaded, which was usually empty.
  const conflicts = useQuery({
    queryKey: ['syncConflicts', unseen],
    queryFn: () => api.syncConflicts(20),
  });

  const acknowledge = useMutation({
    mutationFn: api.acknowledgeSyncConflicts,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
      void queryClient.invalidateQueries({ queryKey: ['syncConflicts'] });
    },
  });

  if (!conflicts.data?.length) return null;

  return (
    <div className="rounded border border-rule bg-board/40 p-3.5">
      <p className="text-base font-medium text-ink">Changed in two places</p>
      <p className="mt-0.5 text-meta text-ink-soft">
        These were changed here and somewhere else at nearly the same time. The newer change was
        kept.
      </p>

      <ul className="mt-3 space-y-1.5">
        {conflicts.data.map((conflict) => (
          <li key={conflict.id} className="text-meta text-ink-soft">
            <span className="text-ink">{labelFor(conflict.tableName)}</span> — {conflict.detail}{' '}
            <span className="text-ink-faint">{formatDateTime(conflict.createdAt)}</span>
          </li>
        ))}
      </ul>

      <Button
        variant="quiet"
        className="mt-3"
        onClick={() => acknowledge.mutate()}
        disabled={acknowledge.isPending}
      >
        I have seen these
      </Button>
    </div>
  );
}

/** Table names are plumbing; the shop sees what the thing is. */
function labelFor(table: string): string {
  const names: Record<string, string> = {
    items: 'An item',
    customers: 'A customer',
    users: 'A person who signs in',
    settings: 'A shop setting',
    categories: 'A category',
    expenses: 'An expense',
    sales: 'A bill',
  };
  return names[table] ?? 'A record';
}

function Row({
  label,
  value,
  alarm,
}: {
  label: string;
  value: string;
  alarm?: boolean;
}): React.JSX.Element {
  return (
    <div className="contents">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={alarm ? 'font-medium text-due' : 'text-ink'}>{value}</dd>
    </div>
  );
}
