import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PAYMENT_METHOD_LABELS,
  formatDate,
  formatPKR,
  formatTime,
  presetRange,
  type DateRange,
} from '@pos/shared';
import { EmptyState, PageHeader, SearchInput, Select, Toolbar } from '@/components/PageHeader';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { SaleDetailDialog } from './SaleDetailDialog';

type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'all';

const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
  all: 'All time',
};

/**
 * Every bill, newest first.
 *
 * Staff without `sale.view_all` are shown only their own — enforced in the main
 * process, not by hiding a filter here.
 */
export function BillsScreen(): React.JSX.Element {
  const { can } = useSession();
  const [preset, setPreset] = useState<Preset>('last7');
  const [search, setSearch] = useState('');
  const [creditOnly, setCreditOnly] = useState(false);
  const [openSaleId, setOpenSaleId] = useState<string | null>(null);

  const range: DateRange | null = useMemo(
    () => (preset === 'all' ? null : presetRange(preset)),
    [preset],
  );

  const sales = useQuery({
    queryKey: ['sales', preset, search, creditOnly],
    queryFn: () =>
      api.sales({
        ...(range ? { from: range.from, to: range.to } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(creditOnly ? { creditOnly: true } : {}),
        limit: 300,
      }),
  });

  const rows = sales.data ?? [];
  const totals = useMemo(() => {
    const active = rows.filter((sale) => sale.status === 'active');
    return {
      count: active.length,
      total: active.reduce((sum, sale) => sum + sale.total, 0),
      credit: active.reduce((sum, sale) => sum + sale.credit, 0),
    };
  }, [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Bills"
        subtitle={
          sales.data
            ? `${totals.count} ${totals.count === 1 ? 'bill' : 'bills'} — ${formatPKR(totals.total)}${
                totals.credit > 0 ? `, ${formatPKR(totals.credit)} on udhaar` : ''
              }`
            : undefined
        }
      />

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search bill number or customer"
          autoFocus
        />
        <Select value={preset} onChange={(value) => setPreset(value as Preset)} label="Date range">
          {(Object.keys(PRESET_LABELS) as Preset[]).map((key) => (
            <option key={key} value={key}>
              {PRESET_LABELS[key]}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-meta text-ink-soft">
          <input
            type="checkbox"
            checked={creditOnly}
            onChange={(event) => setCreditOnly(event.target.checked)}
            className="size-3.5 accent-board"
          />
          Only bills with udhaar
        </label>
        {!can('sale.view_all') && (
          <span className="ml-auto text-meta text-ink-faint">Showing your bills</span>
        )}
      </Toolbar>

      {sales.isPending && <p className="px-6 py-8 text-ink-soft">Loading…</p>}

      {sales.data && rows.length === 0 && (
        <EmptyState
          title="No bills here"
          detail={
            search.trim()
              ? `Nothing matches “${search}” in this period.`
              : preset === 'today'
                ? 'Nothing has been sold yet today.'
                : 'Try a wider date range.'
          }
        />
      )}

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-rule-strong">
                <Th className="w-28 pl-6">Bill</Th>
                <Th className="w-40">When</Th>
                <Th>Customer</Th>
                <Th className="w-36">Paid by</Th>
                <Th className="w-20" align="right">Items</Th>
                <Th className="w-32" align="right">Udhaar</Th>
                <Th className="w-32 pr-6" align="right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((sale) => {
                const voided = sale.status === 'voided';
                return (
                  <tr
                    key={sale.id}
                    onClick={() => setOpenSaleId(sale.id)}
                    className="cursor-pointer border-b border-rule hover:bg-surface"
                  >
                    <td className="tabular py-2.5 pl-6 pr-4 text-row text-ink">
                      {sale.invoiceNo}
                      {voided && (
                        <span className="ml-2 rounded bg-due-tint px-1.5 py-0.5 text-micro font-medium text-due">
                          cancelled
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-meta text-ink-soft">
                      {formatDate(sale.soldAt)}
                      <span className="ml-1.5 text-ink-faint">{formatTime(sale.soldAt)}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-base text-ink">
                      {sale.customerName ?? <span className="text-ink-faint">Walk-in</span>}
                      {sale.returnedTotal > 0 && (
                        <span className="ml-2 text-meta text-brass">
                          {formatPKR(sale.returnedTotal)} returned
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-meta text-ink-soft">
                      {PAYMENT_METHOD_LABELS[sale.paymentMethod]}
                    </td>
                    <td className="tabular py-2.5 pr-4 text-right text-meta text-ink-soft">
                      {sale.lineCount}
                    </td>
                    <td className="tabular py-2.5 pr-4 text-right text-base">
                      {sale.credit > 0 ? (
                        <span className="text-due">{formatPKR(sale.credit)}</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td
                      className={`tabular py-2.5 pr-6 text-right text-row font-medium ${
                        voided ? 'text-ink-faint line-through' : 'text-ink'
                      }`}
                    >
                      {formatPKR(sale.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SaleDetailDialog
        open={openSaleId !== null}
        saleId={openSaleId}
        onClose={() => setOpenSaleId(null)}
      />
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}): React.JSX.Element {
  return (
    <th
      scope="col"
      className={`font-condensed py-2 pr-4 text-meta font-medium text-ink-soft ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}
