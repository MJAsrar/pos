'use client';

import { useCallback, useEffect, useState } from 'react';
import { FIGURE_LABELS, formatPKR, presetRange, type DateRange, type PeriodSummary } from '@pos/shared';
import { Guarded } from '@/components/shell';
import { periodFigures, shopName } from '@/lib/shop';

/**
 * What the owner wants to know when they pick up their phone: what the shop
 * has taken, how much of it is still owed, and what is left after the goods
 * and the spending.
 *
 * Every figure is computed by the same function the till uses, from the same
 * rows. If this page and the counter ever disagree, one of them is looking at
 * a different day — not doing different arithmetic.
 */
export default function DashboardPage() {
  return (
    <Guarded>
      <Dashboard />
    </Guarded>
  );
}

type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth';

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'thisMonth', label: 'This month' },
];

function Dashboard() {
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
    <main className="mt-5">
      <h1 className="text-title font-semibold tracking-tight">{name}</h1>

      <nav className="mt-4 flex flex-wrap gap-1.5">
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
          <div className="rounded border border-rule bg-white px-4 py-5">
            <p className="text-meta text-ink-soft">{FIGURE_LABELS.netSales}</p>
            <p className="mt-1 text-figure font-semibold tracking-tight tabular-nums">
              {formatPKR(figures.netSales)}
            </p>
            <p className="mt-1.5 text-meta text-ink-faint">
              {figures.billCount === 0
                ? 'Nothing sold yet'
                : `${figures.billCount} ${figures.billCount === 1 ? 'bill' : 'bills'}`}
            </p>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-3">
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
