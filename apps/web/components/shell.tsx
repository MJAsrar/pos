'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { forgetSession, readSession, signIn } from '@/lib/shop';
import { forgetActingUser } from '@/lib/push';

/**
 * The frame every page sits in, and the gate in front of it.
 *
 * Whether anyone is signed in is only knowable in the browser, so the page
 * that arrives from the server cannot know which of the two to render. It
 * shows the shop's name and nothing else while it finds out: a blank screen on
 * a slow phone looks broken, and guessing would flash a sign-in form at
 * someone who is already signed in.
 */

export function Guarded({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setSignedIn(readSession() !== null);
    setChecked(true);
  }, []);

  if (!checked) return <Centred>Opening the shop…</Centred>;
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  return (
    <div className="mx-auto max-w-2xl px-4 py-7 sm:px-6">
      <Nav
        onSignOut={() => {
          forgetSession();
          forgetActingUser();
          setSignedIn(false);
        }}
      />
      {children}
    </div>
  );
}

const PAGES = [
  { href: '/', label: 'Today' },
  { href: '/items', label: 'Items' },
  { href: '/customers', label: 'Customers' },
  { href: '/reports', label: 'Reports' },
] as const;

function Nav({ onSignOut }: { onSignOut: () => void }) {
  const here = usePathname();

  return (
    <header className="flex items-center justify-between gap-4 border-b border-rule pb-3">
      <nav className="flex gap-1">
        {PAGES.map((page) => {
          const active = here === page.href;
          return (
            <Link
              key={page.href}
              href={page.href}
              aria-current={active ? 'page' : undefined}
              className={[
                'rounded px-2.5 py-1.5 text-row transition-colors duration-100',
                active ? 'bg-ink font-medium text-white' : 'text-ink-soft hover:bg-rule/60',
              ].join(' ')}
            >
              {page.label}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={onSignOut}
        className="text-meta text-ink-faint underline-offset-2 hover:text-ink hover:underline"
      >
        Sign out
      </button>
    </header>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="text-title font-semibold tracking-tight">Al Hamza Electronics</h1>
      <p className="mt-1.5 text-row text-ink-faint">{children}</p>
    </main>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await signIn(email, password);
      onDone();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="text-title font-semibold tracking-tight">Al Hamza Electronics</h1>
      <p className="mt-1.5 text-row text-ink-soft">Sign in to see the shop.</p>

      <form className="mt-6 space-y-4" onSubmit={submit}>
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />

        {problem && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {problem}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="w-full rounded bg-ink px-4 py-2.5 text-row font-medium text-white disabled:opacity-45"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete = 'off',
  hint,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  hint?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
}) {
  return (
    <label className="block">
      <span className="text-meta text-ink-soft">{label}</span>
      <input
        type={type}
        value={value}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required
        className="mt-1 w-full rounded border border-rule bg-white px-3 py-2.5 text-row outline-none focus:border-board"
      />
      {hint && <span className="mt-1 block text-meta text-ink-faint">{hint}</span>}
    </label>
  );
}
