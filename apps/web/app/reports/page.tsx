'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DUE_BUCKET_LABELS,
  FIGURE_LABELS,
  formatDate,
  formatPKR,
  formatQty,
  presetRange,
  type DateRange,
  type PeriodSummary,
} from '@pos/shared';
import { Guarded } from '@/components/shell';
import { periodFigures } from '@/lib/shop';
import {
  dues,
  notMoving,
  soldInPeriod,
  stockSnapshot,
  type DueRow,
  type NotMovingRow,
  type SoldRow,
  type StockSnapshot,
} from '@/lib/reports';

/**
 * The same six reports the counter has, over any stretch of days.
 *
 * One page rather than six, because on a phone a menu of reports is one more
 * thing to get through before seeing a number. What sold and what was earned
 * follow the chosen dates; what is on the shelves and who owes money are about
 * right now and say so.
 */
export default function ReportsPage() {
  return (
    <Guarded>
      <Reports />
    </Guarded>
  );
}

type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth';

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
];

function Reports() {
  const [preset, setPreset] = useState<Preset>('last7');
  const [figures, setFigures] = useState<PeriodSummary | null>(null);
  const [sold, setSold] = useState<SoldRow[] | null>(null);
  const [stock, setStock] = useState<StockSnapshot | null>(null);
  const [stale, setStale] = useState<NotMovingRow[] | null>(null);
  const [owing, setOwing] = useState<{ rows: DueRow[]; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (range: DateRange) => {
    setLoading(true);
    setProblem(null);
    try {
      const [summary, lines, shelves, idle, debts] = await Promise.all([
        periodFigures(range),
        soldInPeriod(range),
        stockSnapshot(),
        notMoving(),
        dues(),
      ]);
      setFigures(summary);
      setSold(lines);
      setStock(shelves);
      setStale(idle);
      setOwing(debts);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The reports could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(presetRange(preset));
  }, [preset, load]);

  const range = presetRange(preset);

  return (
    <main className="mt-5 pb-10">
      <h1 className="text-title font-semibold tracking-tight">Reports</h1>

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

      <p className="mt-2 text-meta text-ink-faint">
        {range.from === range.to
          ? formatDate(range.from)
          : `${formatDate(range.from)} to ${formatDate(range.to)}`}
      </p>

      {problem && (
        <p className="mt-5 rounded border border-due/30 bg-due-tint px-3.5 py-3 text-row text-due">
          {problem}
        </p>
      )}

      {loading && !figures && <p className="mt-6 text-ink-soft">Loading…</p>}

      <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {figures && (
          <Section title="Sales and profit" detail="Cancelled bills are left out; returns come off both the takings and the cost.">
            <dl className="grid grid-cols-2 gap-3">
              <Figure label={FIGURE_LABELS.netSales} amount={figures.netSales} lead />
              <Figure label={FIGURE_LABELS.grossProfit} amount={figures.grossProfit} />
              <Figure label={FIGURE_LABELS.expenses} amount={figures.expenses} />
              <Figure
                label={FIGURE_LABELS.netProfit}
                amount={figures.netProfit}
                tone={figures.netProfit < 0 ? 'bad' : 'kept'}
              />
            </dl>
            <dl className="mt-3 space-y-1.5 rounded border border-rule bg-white px-3.5 py-3">
              <Line label={FIGURE_LABELS.billCount} value={String(figures.billCount)} />
              <Line label={FIGURE_LABELS.cashTaken} value={formatPKR(figures.cashTaken)} />
              <Line label={FIGURE_LABELS.onCredit} value={formatPKR(figures.onCredit)} />
              <Line label={FIGURE_LABELS.returns} value={formatPKR(figures.returns)} />
              <Line label={FIGURE_LABELS.discounts} value={formatPKR(figures.discounts)} />
            </dl>
          </Section>
        )}

        {sold && (
          <Section title="Best sellers" detail="By quantity, over the chosen dates.">
            {sold.length === 0 ? (
              <Empty>Nothing sold in this period.</Empty>
            ) : (
              <Table
                head={['Item', 'Sold', 'Takings', 'Profit']}
                rows={sold.slice(0, 15).map((row) => [
                  <span key="n" className="block truncate">
                    <span className="font-mono text-meta text-ink-faint">{row.code}</span> {row.name}
                  </span>,
                  formatQty(row.qty),
                  formatPKR(row.takings, { symbol: false }),
                  formatPKR(row.profit, { symbol: false }),
                ])}
              />
            )}
          </Section>
        )}

        {stock && (
          <Section title="On the shelves" detail="As it stands now, not over the chosen dates.">
            <dl className="grid grid-cols-2 gap-3">
              <Figure label="Stock at cost" amount={stock.totalCost} lead />
              <Figure label="Stock at selling price" amount={stock.totalRetail} />
            </dl>

            {stock.nothingLeft.length > 0 && (
              <>
                <h3 className="mt-5 text-meta font-medium text-ink-soft">
                  Nothing left ({stock.nothingLeft.length})
                </h3>
                <Table
                  head={['Item', 'Count']}
                  rows={stock.nothingLeft.slice(0, 15).map((item) => [
                    <span key="n" className="block truncate">
                      <span className="font-mono text-meta text-ink-faint">{item.code}</span>{' '}
                      {item.name}
                    </span>,
                    formatQty(item.qtyOnHand),
                  ])}
                />
              </>
            )}

            {stock.runningLow.length > 0 && (
              <>
                <h3 className="mt-5 text-meta font-medium text-ink-soft">
                  Running low ({stock.runningLow.length})
                </h3>
                <Table
                  head={['Item', 'Left', 'Order at']}
                  rows={stock.runningLow.slice(0, 15).map((item) => [
                    <span key="n" className="block truncate">
                      <span className="font-mono text-meta text-ink-faint">{item.code}</span>{' '}
                      {item.name}
                    </span>,
                    formatQty(item.qtyOnHand),
                    formatQty(item.lowStockLevel),
                  ])}
                />
              </>
            )}

            {stock.rows.length === 0 && (
              <Empty>
                Nothing has been counted onto the shelves yet, so there is no stock value to show.
              </Empty>
            )}
          </Section>
        )}

        {stale && stale.length > 0 && (
          <Section title="Not moving" detail="Holding money and not selling, for ninety days or more.">
            <Table
              head={['Item', 'Left', 'At cost', 'Last sold']}
              rows={stale.slice(0, 15).map((row) => [
                <span key="n" className="block truncate">
                  <span className="font-mono text-meta text-ink-faint">{row.code}</span> {row.name}
                </span>,
                formatQty(row.qtyOnHand),
                formatPKR(row.stockCost, { symbol: false }),
                row.lastSoldAt ? `${row.days} days` : 'never',
              ])}
            />
          </Section>
        )}

        {owing && (
          <Section title="Owed to the shop" detail="Oldest first, because those are the ones to chase.">
            {owing.rows.length === 0 ? (
              <Empty>Nobody owes anything.</Empty>
            ) : (
              <>
                <dl className="grid grid-cols-1 gap-3">
                  <Figure label="Owed to the shop" amount={owing.total} lead />
                </dl>
                <Table
                  head={['Customer', 'Owed', 'Waiting']}
                  rows={owing.rows.map((row) => [
                    <span key="n" className="block truncate">
                      {row.name}
                      {row.phone && <span className="text-ink-faint"> · {row.phone}</span>}
                    </span>,
                    formatPKR(row.balance, { symbol: false }),
                    DUE_BUCKET_LABELS[row.bucket],
                  ])}
                />
              </>
            )}
          </Section>
        )}
      </div>
    </main>
  );
}

function Section({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7 border-t border-rule pt-5 first:border-t-0">
      <h2 className="text-section font-semibold">{title}</h2>
      {detail && <p className="mt-0.5 mb-3 text-meta text-ink-soft">{detail}</p>}
      {children}
    </section>
  );
}

function Figure({
  label,
  amount,
  tone = 'plain',
  lead,
}: {
  label: string;
  amount: number;
  tone?: 'plain' | 'bad' | 'kept';
  lead?: boolean;
}) {
  const colour = tone === 'bad' ? 'text-due' : tone === 'kept' ? 'text-kept' : 'text-ink';
  return (
    <div className="rounded border border-rule bg-white px-3.5 py-3">
      <dt className="text-meta text-ink-soft">{label}</dt>
      <dd
        className={`mt-0.5 font-semibold tabular-nums ${lead ? 'text-figure' : 'text-section'} ${colour}`}
      >
        {formatPKR(amount)}
      </dd>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-row">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="mt-2 overflow-hidden rounded border border-rule bg-white">
      <table className="w-full table-fixed text-meta">
        <thead>
          <tr className="border-b border-rule text-ink-soft">
            {head.map((cell, index) => (
              <th
                key={cell}
                className={`px-3 py-2 font-medium ${index === 0 ? 'text-left' : 'w-20 text-right'}`}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-rule last:border-b-0">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`px-3 py-2 ${index === 0 ? 'min-w-0' : 'text-right tabular-nums'}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded border border-rule bg-white px-3.5 py-3 text-row text-ink-soft">{children}</p>;
}
