'use client';

import { useCallback, useEffect, useState } from 'react';
import { FIGURE_LABELS, formatPKR, presetRange, type DateRange, type PeriodSummary } from '@pos/shared';
import {
  forgetSession,
  periodFigures,
  readSession,
  shopName,
  signIn,
} from '@/lib/shop';

/**
 * What the owner wants to know when they pick up their phone: what has the
 * shop taken today, how much of it is still owed, and what is left after the
 * goods and the spending.
 *
 * Every figure here is computed by the same function the till uses, from the
 * same rows, so the two cannot drift. If this page and the counter ever
 * disagree, one of them is reading a different day — not doing different
 * arithmetic.
 */

type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth';

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'thisMonth', label: 'This month' },
];

export default function Dashboard() {
  const [signedIn, setSignedIn] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setSignedIn(readSession() !== null);
    setChecked(true);
  }, []);

  // Whether anyone is signed in is only knowable in the browser, so the page
  // that arrives from the server cannot know which of the two to show. It
  // shows the shop's name and nothing else: a blank screen on a slow phone
  // looks broken, and guessing wrong would flash a sign-in form at someone
  // who is already signed in.
  if (!checked) return <Waiting />;
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  return <Shop onSignOut={() => { forgetSession(); setSignedIn(false); }} />;
}

function Waiting() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="text-title font-semibold tracking-tight">Al Hamza Electronics</h1>
      <p className="mt-1.5 text-row text-ink-faint">Opening the shop…</p>
    </main>
  );
}

function Shop({ onSignOut }: { onSignOut: () => void }) {
  const [preset, setPreset] = useState<Preset>('today');
  const [figures, setFigures] = useState<PeriodSummary | null>(null);
  const [name, setName] = useState('Al Hamza Electronics');
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (range: DateRange) => {
    setLoading(true);
    setProblem(null);
    try {
      const [summary, shop] = await Promise.all([periodFigures(range), shopName()]);
      setFigures(summary);
      setName(shop);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The shop could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(presetRange(preset));
  }, [preset, load]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-7 sm:px-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-title font-semibold tracking-tight">{name}</h1>
        <button
          type="button"
          onClick={onSignOut}
          className="text-meta text-ink-faint underline-offset-2 hover:text-ink hover:underline"
        >
          Sign out
        </button>
      </header>

      <nav className="mt-5 flex flex-wrap gap-1.5">
        {PRESETS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setPreset(option.id)}
            aria-current={option.id === preset ? 'true' : undefined}
            className={[
              'rounded-full px-3.5 py-1.5 text-meta transition-colors duration-100',
              option.id === preset
                ? 'bg-ink font-medium text-white'
                : 'border border-rule bg-white text-ink-soft hover:border-ink-faint',
            ].join(' ')}
          >
            {option.label}
          </button>
        ))}
      </nav>

      {problem && (
        <p className="mt-5 rounded border border-due/30 bg-due-tint px-3.5 py-3 text-row text-due">
          {problem}
        </p>
      )}

      {loading && !figures && <p className="mt-6 text-ink-soft">Loading…</p>}

      {figures && (
        <div className={loading ? 'mt-6 opacity-60 transition-opacity' : 'mt-6 transition-opacity'}>
          <Lead summary={figures} />

          <dl className="mt-4 grid grid-cols-2 gap-3">
            <Figure label={FIGURE_LABELS.grossProfit} amount={figures.grossProfit} />
            <Figure label={FIGURE_LABELS.expenses} amount={figures.expenses} />
            <Figure
              label={FIGURE_LABELS.netProfit}
              amount={figures.netProfit}
              tone={figures.netProfit < 0 ? 'bad' : 'kept'}
            />
            <Figure
              label={FIGURE_LABELS.onCredit}
              amount={figures.onCredit}
              tone={figures.onCredit > 0 ? 'bad' : 'plain'}
            />
          </dl>

          <details className="mt-5 rounded border border-rule bg-white px-3.5 py-3">
            <summary className="cursor-pointer text-meta text-ink-soft">The numbers behind it</summary>
            <dl className="mt-3 space-y-1.5">
              <Line label={FIGURE_LABELS.grossSales} amount={figures.grossSales} />
              <Line label={FIGURE_LABELS.discounts} amount={figures.discounts} />
              <Line label={FIGURE_LABELS.returns} amount={figures.returns} />
              <Line label={FIGURE_LABELS.costOfGoods} amount={figures.costOfGoods} />
              <Line label={FIGURE_LABELS.cashTaken} amount={figures.cashTaken} />
            </dl>
          </details>
        </div>
      )}
    </main>
  );
}

function Lead({ summary }: { summary: PeriodSummary }) {
  return (
    <div className="rounded border border-rule bg-white px-4 py-5">
      <dt className="text-meta text-ink-soft">{FIGURE_LABELS.netSales}</dt>
      <dd className="mt-1 text-figure font-semibold tracking-tight tabular-nums">
        {formatPKR(summary.netSales)}
      </dd>
      <p className="mt-1.5 text-meta text-ink-faint">
        {summary.billCount === 0
          ? 'Nothing sold yet'
          : `${summary.billCount} ${summary.billCount === 1 ? 'bill' : 'bills'}`}
      </p>
    </div>
  );
}

function Figure({
  label,
  amount,
  tone = 'plain',
}: {
  label: string;
  amount: number;
  tone?: 'plain' | 'bad' | 'kept';
}) {
  const colour = tone === 'bad' ? 'text-due' : tone === 'kept' ? 'text-kept' : 'text-ink';
  return (
    <div className="rounded border border-rule bg-white px-3.5 py-3">
      <dt className="text-meta text-ink-soft">{label}</dt>
      <dd className={`mt-0.5 text-section font-semibold tabular-nums ${colour}`}>
        {formatPKR(amount)}
      </dd>
    </div>
  );
}

function Line({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-row">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="tabular-nums">{formatPKR(amount)}</dd>
    </div>
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
        <label className="block">
          <span className="text-meta text-ink-soft">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
            className="mt-1 w-full rounded border border-rule bg-white px-3 py-2.5 text-row outline-none focus:border-board"
          />
        </label>

        <label className="block">
          <span className="text-meta text-ink-soft">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded border border-rule bg-white px-3 py-2.5 text-row outline-none focus:border-board"
          />
        </label>

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
