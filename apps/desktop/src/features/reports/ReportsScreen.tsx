import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  DUE_BUCKET_LABELS,
  PAYMENT_METHOD_LABELS,
  dueBucket,
  formatDate,
  formatPKR,
  formatQty,
  presetRange,
  type DateRange,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { DailySalesChart } from '@/components/DailySalesChart';
import { EmptyState, PageHeader, Select, Toolbar } from '@/components/PageHeader';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

type Tab = 'sales' | 'stock' | 'dues';
type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth';

const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
};

/**
 * Reports.
 *
 * Three questions, three tabs: what did we take, what is on the shelves, and who
 * owes us. Profit figures are absent entirely for anyone without permission to
 * see them — the main process does not send them, so there is nothing to hide.
 */
export function ReportsScreen(): React.JSX.Element {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('sales');
  const [preset, setPreset] = useState<Preset>('last7');
  const range: DateRange = useMemo(() => presetRange(preset), [preset]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Reports"
        subtitle={
          range.from === range.to
            ? formatDate(range.from)
            : `${formatDate(range.from)} to ${formatDate(range.to)}`
        }
        actions={<SaveReport range={range} />}
      />

      <Toolbar>
        <nav className="flex gap-1" aria-label="Report">
          {(
            [
              ['sales', 'Sales & profit'],
              ['stock', 'Stock'],
              ['dues', 'Customer dues'],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={`rounded px-3 py-1.5 text-base transition-colors duration-100 ${
                tab === id ? 'bg-ink font-medium text-white' : 'text-ink-soft hover:bg-sunk hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'sales' && (
          <Select
            className="ml-auto"
            value={preset}
            onChange={(value) => setPreset(value as Preset)}
            label="Date range"
          >
            {(Object.keys(PRESET_LABELS) as Preset[]).map((key) => (
              <option key={key} value={key}>
                {PRESET_LABELS[key]}
              </option>
            ))}
          </Select>
        )}
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'sales' && <SalesReport range={range} canSeeProfit={can('report.view_profit')} />}
        {tab === 'stock' && <StockReport range={range} canSeeCost={can('item.view_cost')} />}
        {tab === 'dues' && <DuesReport />}
      </div>
    </div>
  );
}

/**
 * Save the whole report as one file, in the folder with the receipts.
 *
 * One file rather than one per tab: this gets attached to something and sent,
 * and three attachments is three chances to send the wrong one. Profit is left
 * out of the file for anyone not allowed to see it, which the main process
 * decides — not this button.
 */
function SaveReport({ range }: { range: DateRange }): React.JSX.Element {
  const save = useMutation({ mutationFn: () => api.exportReport(range) });

  return (
    <div className="flex items-center gap-3">
      {save.data && (
        <button
          type="button"
          onClick={() => void api.openFolder('reports')}
          className="text-meta text-ink-soft underline-offset-2 hover:text-ink hover:underline"
        >
          Saved as {save.data.fileName} — open the folder
        </button>
      )}
      {save.error && <span className="text-meta text-due">It could not be saved.</span>}
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save as a file'}
      </Button>
    </div>
  );
}

function SalesReport({
  range,
  canSeeProfit,
}: {
  range: DateRange;
  canSeeProfit: boolean;
}): React.JSX.Element {
  const report = useQuery({
    queryKey: ['report', 'sales', range.from, range.to],
    queryFn: () => api.salesReport(range),
  });

  if (report.isPending) return <p className="px-6 py-8 text-ink-soft">Loading…</p>;
  if (!report.data) return <EmptyState title="The report could not be loaded" />;

  const data = report.data;
  if (data.billCount === 0) {
    return <EmptyState title="Nothing was sold in this period" detail="Try a wider date range." />;
  }

  return (
    <div className="px-6 py-5">
      <StatRow>
        <Stat label="Takings" value={formatPKR(data.netSales)} lead />
        {canSeeProfit && data.grossProfit !== null && (
          <Stat label="Profit on goods" value={formatPKR(data.grossProfit)} />
        )}
        {canSeeProfit && data.expenses !== null && (
          <Stat label="Expenses" value={formatPKR(data.expenses)} />
        )}
        {canSeeProfit && data.netProfit !== null && (
          <Stat
            label="Left over"
            value={formatPKR(data.netProfit)}
            tone={data.netProfit >= 0 ? 'good' : 'bad'}
            lead
          />
        )}
        <Stat label="Bills" value={String(data.billCount)} />
        <Stat label="Went on udhaar" value={formatPKR(data.onCredit)} tone={data.onCredit > 0 ? 'bad' : 'plain'} />
      </StatRow>

      {data.byDay.length > 1 && (
        <section className="mt-7 border-t border-rule pt-5">
          <h2 className="mb-3 text-section font-semibold text-ink">Day by day</h2>
          <DailySalesChart days={data.byDay} />
        </section>
      )}

      <div className="mt-7 grid grid-cols-2 gap-x-10 gap-y-7 border-t border-rule pt-5">
        <section>
          <h2 className="mb-3 text-section font-semibold text-ink">How they paid</h2>
          <SimpleTable
            head={['Method', 'Bills', 'Amount']}
            rows={data.byMethod.map((row) => [
              PAYMENT_METHOD_LABELS[row.method],
              String(row.billCount),
              formatPKR(row.total),
            ])}
          />
        </section>

        <section>
          <h2 className="mb-3 text-section font-semibold text-ink">Who sold</h2>
          <SimpleTable
            head={['Person', 'Bills', 'Amount']}
            rows={data.byUser.map((row) => [row.userName, String(row.billCount), formatPKR(row.netSales)])}
          />
        </section>

        {canSeeProfit && data.expenseBreakdown.length > 0 && (
          <section>
            <h2 className="mb-3 text-section font-semibold text-ink">What was spent</h2>
            <SimpleTable
              head={['Category', '', 'Amount']}
              rows={data.expenseBreakdown.map((row) => [row.category, '', formatPKR(row.total)])}
            />
          </section>
        )}

        <section>
          <h2 className="mb-3 text-section font-semibold text-ink">The numbers behind it</h2>
          <SimpleTable
            head={['', '', '']}
            rows={[
              ['Sold before discount', '', formatPKR(data.grossSales)],
              ['Discounts given', '', formatPKR(data.discounts)],
              ['Returned', '', formatPKR(data.returns)],
              ...(canSeeProfit && data.costOfGoods !== null
                ? [['What the goods cost', '', formatPKR(data.costOfGoods)] as [string, string, string]]
                : []),
              ['Money actually taken', '', formatPKR(data.cashTaken)],
            ]}
          />
        </section>
      </div>
    </div>
  );
}

function StockReport({
  range,
  canSeeCost,
}: {
  range: DateRange;
  canSeeCost: boolean;
}): React.JSX.Element {
  const value = useQuery({ queryKey: ['report', 'stockValue'], queryFn: api.stockValue });
  const low = useQuery({ queryKey: ['report', 'lowStock'], queryFn: api.lowStock });
  const best = useQuery({
    queryKey: ['report', 'bestSellers', range.from, range.to],
    queryFn: () => api.bestSellers(range, 15),
  });
  const dead = useQuery({ queryKey: ['report', 'deadStock'], queryFn: () => api.deadStock(90) });

  return (
    <div className="px-6 py-5">
      <StatRow>
        {canSeeCost && value.data?.totalCost !== null && value.data && (
          <Stat label="Stock at cost" value={formatPKR(value.data.totalCost)} lead />
        )}
        {value.data && <Stat label="Stock at selling price" value={formatPKR(value.data.totalRetail)} />}
        <Stat label="Items on the shelves" value={String(value.data?.rows.length ?? 0)} />
        <Stat
          label="Running low"
          value={String(low.data?.length ?? 0)}
          tone={(low.data?.length ?? 0) > 0 ? 'warn' : 'plain'}
        />
      </StatRow>

      <div className="mt-7 grid grid-cols-2 gap-x-10 gap-y-7 border-t border-rule pt-5">
        <section>
          <h2 className="mb-1 text-section font-semibold text-ink">Order these soon</h2>
          <p className="mb-3 text-meta text-ink-soft">
            At or below the level you set, busiest first.
          </p>
          {low.data?.length === 0 ? (
            <p className="text-meta text-ink-faint">Nothing is running low.</p>
          ) : (
            <SimpleTable
              head={['Item', 'Sold in 30 days', 'Left']}
              rows={(low.data ?? []).map((row) => [
                row.name,
                formatQty(row.soldLast30),
                `${formatQty(row.qtyOnHand)} ${row.unit}`,
              ])}
            />
          )}
        </section>

        <section>
          <h2 className="mb-1 text-section font-semibold text-ink">Best sellers</h2>
          <p className="mb-3 text-meta text-ink-soft">In the selected period, by quantity.</p>
          {best.data?.length === 0 ? (
            <p className="text-meta text-ink-faint">Nothing sold in this period.</p>
          ) : (
            <SimpleTable
              head={['Item', 'Sold', 'Brought in']}
              rows={(best.data ?? []).map((row) => [
                row.name,
                formatQty(row.qtySold),
                formatPKR(row.revenue),
              ])}
            />
          )}
        </section>

        <section className="col-span-2">
          <h2 className="mb-1 text-section font-semibold text-ink">Not moving</h2>
          <p className="mb-3 text-meta text-ink-soft">
            In stock but not sold for 90 days — money sitting on the shelf.
          </p>
          {dead.data?.length === 0 ? (
            <p className="text-meta text-ink-faint">Everything has sold recently.</p>
          ) : (
            <SimpleTable
              head={['Item', 'In stock', canSeeCost ? 'Tied up' : 'Last sold']}
              rows={(dead.data ?? []).slice(0, 20).map((row) => [
                row.name,
                formatQty(row.qtyOnHand),
                canSeeCost && row.stockCost !== null
                  ? formatPKR(row.stockCost)
                  : row.lastSoldAt
                    ? formatDate(row.lastSoldAt)
                    : 'never sold',
              ])}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function DuesReport(): React.JSX.Element {
  const dues = useQuery({ queryKey: ['report', 'dues'], queryFn: api.dues });

  if (dues.isPending) return <p className="px-6 py-8 text-ink-soft">Loading…</p>;
  if (!dues.data || dues.data.length === 0) {
    return <EmptyState title="Nobody owes anything" detail="Every account is clear." />;
  }

  const total = dues.data.reduce((sum, row) => sum + row.balance, 0);
  const oldest = dues.data.filter((row) => row.daysOutstanding >= 60);

  return (
    <div className="px-6 py-5">
      <StatRow>
        <Stat label="Owed to the shop" value={formatPKR(total)} tone="bad" lead />
        <Stat label="Customers owing" value={String(dues.data.length)} />
        <Stat
          label="Older than 60 days"
          value={String(oldest.length)}
          tone={oldest.length > 0 ? 'warn' : 'plain'}
        />
      </StatRow>

      <table className="mt-6 w-full border-collapse border-t border-rule pt-4">
        <thead>
          <tr className="border-b border-rule-strong">
            <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
              Customer
            </th>
            <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
              Phone
            </th>
            <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
              How old
            </th>
            <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
              Last paid
            </th>
            <th
              scope="col"
              className="font-condensed border-l border-rule-strong py-2 pl-4 text-right text-meta font-medium text-ink-soft"
            >
              Owes
            </th>
          </tr>
        </thead>
        <tbody>
          {dues.data.map((row) => {
            const bucket = dueBucket(row.daysOutstanding);
            return (
              <tr key={row.customerId} className="border-b border-rule">
                <td className="py-2 pr-4 text-row text-ink">{row.name}</td>
                <td className="tabular py-2 pr-4 text-meta text-ink-soft">{row.phone ?? '—'}</td>
                <td className="py-2 pr-4 text-meta">
                  <span className={bucket === '90plus' ? 'text-due' : bucket === '60' ? 'text-brass' : 'text-ink-soft'}>
                    {DUE_BUCKET_LABELS[bucket]}
                  </span>
                </td>
                <td className="py-2 pr-4 text-meta text-ink-soft">
                  {row.lastPaymentAt ? formatDate(row.lastPaymentAt) : 'never'}
                </td>
                <td className="tabular border-l border-rule-strong py-2 pl-4 text-right text-row font-medium text-due">
                  {formatPKR(row.balance)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Pieces ----------------------------------------------------------------

function StatRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-x-12 gap-y-4">{children}</div>;
}

function Stat({
  label,
  value,
  tone = 'plain',
  lead = false,
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'good' | 'bad' | 'warn';
  lead?: boolean;
}): React.JSX.Element {
  const colour =
    tone === 'bad' ? 'text-due' : tone === 'warn' ? 'text-brass' : tone === 'good' ? 'text-board' : 'text-ink';
  return (
    <div>
      <p className="text-meta text-ink-soft">{label}</p>
      <p className={`tabular mt-0.5 font-semibold ${lead ? 'text-title' : 'text-section'} ${colour}`}>
        {value}
      </p>
    </div>
  );
}

function SimpleTable({
  head,
  rows,
}: {
  head: [string, string, string];
  rows: Array<[string, string, string]>;
}): React.JSX.Element {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-rule-strong">
          {head.map((label, index) => (
            <th
              key={index}
              scope="col"
              className={`font-condensed pb-1.5 text-meta font-medium text-ink-soft ${
                index === 0 ? 'text-left' : 'pl-4 text-right'
              }`}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-b border-rule">
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className={`py-1.5 text-base ${
                  cellIndex === 0
                    ? 'pr-4 text-ink'
                    : cellIndex === 2
                      ? 'tabular pl-4 text-right font-medium text-ink'
                      : 'tabular pl-4 text-right text-ink-soft'
                }`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
