'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_STAFF_PERMISSIONS,
  GRANTABLE_PERMISSIONS,
  PERMISSION_LABELS,
  PIN_LENGTH,
  formatDateTime,
  pinWeakness,
  type Permission,
} from '@pos/shared';
import { Field, Guarded } from '@/components/shell';
import { accessToken, read } from '@/lib/shop';
import { setActive } from '@/lib/push';

/**
 * Who can sign in at the counter, and what each of them may do.
 *
 * Written as "what they can do", never "permissions": the owner is deciding
 * whether Imran may give discounts, not administering a role-based access
 * control system.
 *
 * Setting a PIN is the only thing on the website that goes through a server of
 * ours, because the PIN has to become a hash somewhere the browser cannot be
 * made to skip. Everything else here is an ordinary change, sent the same way
 * a price change is.
 */
export default function PeoplePage() {
  return (
    <Guarded>
      <People />
    </Guarded>
  );
}

interface Person {
  id: string;
  username: string;
  fullName: string;
  role: 'admin' | 'staff';
  isActive: boolean;
  permissions: Permission[];
  lastLoginAt: string | null;
}

async function listPeople(): Promise<Person[]> {
  const rows = await read<{
    id: string;
    username: string;
    full_name: string;
    role: 'admin' | 'staff';
    is_active: number;
    permissions_json: string;
    last_login_at: string | null;
  }>(
    'users?select=id,username,full_name,role,is_active,permissions_json,last_login_at&deleted_at=is.null&order=role,full_name',
  );

  return rows.map((row) => {
    let permissions: Permission[] = [];
    try {
      const parsed: unknown = JSON.parse(row.permissions_json);
      if (Array.isArray(parsed)) permissions = parsed as Permission[];
    } catch {
      // A row we cannot read the list from is shown with nothing ticked
      // rather than hidden, so it can at least be fixed.
    }
    return {
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active === 1,
      permissions,
      lastLoginAt: row.last_login_at,
    };
  });
}

function People() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Person | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setPeople(await listPeople());
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The list could not be read.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-title font-semibold tracking-tight">Who can sign in</h1>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded bg-ink px-3 py-1.5 text-meta font-medium text-white"
        >
          Add someone
        </button>
      </div>

      {problem && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3.5 py-3 text-row text-due">
          {problem}
        </p>
      )}

      {!people && !problem && <p className="mt-6 text-ink-soft">Loading…</p>}

      <ul className="mt-4 space-y-3">
        {people?.map((person) => (
          <li key={person.id} className="rounded border border-rule bg-white px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-row font-medium">
                  {person.fullName}
                  {!person.isActive && <span className="text-ink-faint"> · switched off</span>}
                </p>
                <p className="text-meta text-ink-faint">
                  signs in as {person.username} ·{' '}
                  {person.role === 'admin' ? 'the owner' : 'staff'}
                  {person.lastLoginAt
                    ? ` · last here ${formatDateTime(person.lastLoginAt)}`
                    : ' · never signed in'}
                </p>
              </div>
            </div>

            {person.role === 'staff' && (
              <p className="mt-2 text-meta text-ink-soft">
                {person.permissions.length === 0
                  ? 'Cannot do anything yet.'
                  : person.permissions
                      .map((permission) => PERMISSION_LABELS[permission] ?? permission)
                      .join(' · ')}
              </p>
            )}
            {person.role === 'admin' && (
              <p className="mt-2 text-meta text-ink-soft">Can do everything.</p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setResetting(person)}
                className="rounded border border-rule px-3 py-1.5 text-meta"
              >
                Change their PIN
              </button>
              {person.role === 'staff' && (
                <SwitchButton person={person} onDone={load} onProblem={setProblem} />
              )}
            </div>
          </li>
        ))}
      </ul>

      {adding && (
        <AddPerson
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {resetting && (
        <ChangePin
          person={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function SwitchButton({
  person,
  onDone,
  onProblem,
}: {
  person: Person;
  onDone: () => void;
  onProblem: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await setActive(person.id, !person.isActive);
          onDone();
        } catch (cause) {
          onProblem(cause instanceof Error ? cause.message : 'That did not save.');
        } finally {
          setBusy(false);
        }
      }}
      className="rounded border border-rule px-3 py-1.5 text-meta"
    >
      {busy ? 'Saving…' : person.isActive ? 'Stop them signing in' : 'Let them sign in again'}
    </button>
  );
}

/** Both the PIN forms post to the one route that does the hashing. */
async function postStaff(body: unknown): Promise<void> {
  const jwt = await accessToken();
  const response = await fetch('/api/staff', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? 'That did not save.');
  }
}

function Sheet({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-10 flex items-end bg-ink/35 sm:items-center sm:justify-center">
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-paper p-5 sm:max-w-md sm:rounded-xl">
        <h2 className="text-section font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function AddPerson({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [allowed, setAllowed] = useState<Permission[]>([...DEFAULT_STAFF_PERMISSIONS]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const weakness = pin.length === PIN_LENGTH ? pinWeakness(pin) : null;
  const ready = fullName.trim().length >= 2 && username.trim().length >= 3 && pin.length === PIN_LENGTH && !weakness;

  return (
    <Sheet title="Add someone">
      <p className="mt-0.5 text-meta text-ink-soft">
        They will sign in at the counter with the PIN you choose here. Tick what they are allowed to
        do — you can change it later.
      </p>

      <div className="mt-5 space-y-4">
        <Field label="Their name" value={fullName} onChange={setFullName} />
        <Field
          label="Sign-in name"
          value={username}
          onChange={(value) => setUsername(value.toLowerCase())}
          hint="Short and lower case, like imran."
        />
        <Field
          label={`PIN (${PIN_LENGTH} digits)`}
          value={pin}
          onChange={(value) => setPin(value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
          inputMode="numeric"
          hint={weakness ?? 'They type this every time they sign in.'}
        />

        <fieldset className="border-t border-rule pt-4">
          <legend className="text-meta font-medium text-ink-soft">What they can do</legend>
          <div className="mt-2 space-y-1.5">
            {GRANTABLE_PERMISSIONS.map((permission) => (
              <label key={permission} className="flex items-start gap-2.5 text-row">
                <input
                  type="checkbox"
                  checked={allowed.includes(permission)}
                  onChange={(event) =>
                    setAllowed((current) =>
                      event.target.checked
                        ? [...current, permission]
                        : current.filter((held) => held !== permission),
                    )
                  }
                  className="mt-1"
                />
                <span>{PERMISSION_LABELS[permission] ?? permission}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {problem && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {problem}
        </p>
      )}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              await postStaff({ fullName: fullName.trim(), username: username.trim(), pin, permissions: allowed });
              onAdded();
            } catch (cause) {
              setProblem(cause instanceof Error ? cause.message : 'That did not save.');
            } finally {
              setBusy(false);
            }
          }}
          className="flex-1 rounded bg-ink px-4 py-2.5 text-row font-medium text-white disabled:opacity-45"
        >
          {busy ? 'Adding…' : 'Add them'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded border border-rule bg-white px-4 py-2.5 text-row"
        >
          Close
        </button>
      </div>
    </Sheet>
  );
}

function ChangePin({
  person,
  onClose,
  onDone,
}: {
  person: Person;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const weakness = pin.length === PIN_LENGTH ? pinWeakness(pin) : null;

  return (
    <Sheet title={`Change the PIN for ${person.fullName}`}>
      <p className="mt-0.5 text-meta text-ink-soft">
        The old PIN stops working straight away. Tell them the new one.
      </p>

      <div className="mt-5">
        <Field
          label={`New PIN (${PIN_LENGTH} digits)`}
          value={pin}
          onChange={(value) => setPin(value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
          inputMode="numeric"
          hint={weakness ?? undefined}
        />
      </div>

      {problem && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {problem}
        </p>
      )}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={pin.length !== PIN_LENGTH || Boolean(weakness) || busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              await postStaff({ userId: person.id, pin });
              onDone();
            } catch (cause) {
              setProblem(cause instanceof Error ? cause.message : 'That did not save.');
            } finally {
              setBusy(false);
            }
          }}
          className="flex-1 rounded bg-ink px-4 py-2.5 text-row font-medium text-white disabled:opacity-45"
        >
          {busy ? 'Saving…' : 'Set the new PIN'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded border border-rule bg-white px-4 py-2.5 text-row"
        >
          Close
        </button>
      </div>
    </Sheet>
  );
}
