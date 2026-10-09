import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPKR, formatQty } from '@pos/shared';
import { Button } from '@/components/Button';
import { EmptyState, PageHeader, SearchInput, Select, Toolbar } from '@/components/PageHeader';
import { api, type Item } from '@/lib/api';
import { searchItems } from '@/lib/search';
import { useSession } from '@/lib/session';
import { ItemEditorDialog } from './ItemEditorDialog';
import { AdjustStockDialog, StockHistoryDialog, StockInDialog } from './StockDialogs';
import { CategoriesDialog } from './CategoriesDialog';
import { ImportItemsDialog } from './ImportItemsDialog';
import { StockCountDialog } from './StockCountDialog';

type Dialog =
  | 'none'
  | 'edit'
  | 'stockIn'
  | 'adjust'
  | 'history'
  | 'import'
  | 'categories'
  | 'count';
type StockFilter = 'all' | 'low' | 'out';

/**
 * The item list.
 *
 * Doubles as the stock screen, because "what have I got" and "what does it cost"
 * are the same question asked at the same moment. Low and out-of-stock rows are
 * marked in place rather than hidden behind a separate report.
 */
export function ItemsScreen(): React.JSX.Element {
  const { can } = useSession();
  const canSeeCost = can('item.view_cost');
  const canManage = can('item.manage');
  const canManageStock = can('stock.manage');

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<Dialog>('none');
  const [active, setActive] = useState<Item | null>(null);

  const items = useQuery({
    queryKey: ['items', showInactive],
    queryFn: () => api.items(showInactive),
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories });

  const rows = useMemo(() => {
    let list = items.data ?? [];

    if (categoryId !== 'all') {
      list = list.filter((item) =>
        categoryId === 'none' ? item.categoryId === null : item.categoryId === categoryId,
      );
    }
    if (stockFilter === 'low') {
      list = list.filter((item) => item.lowStockLevel > 0 && item.qtyOnHand <= item.lowStockLevel);
    } else if (stockFilter === 'out') {
      list = list.filter((item) => item.qtyOnHand <= 0);
    }
    if (search.trim()) {
      list = searchItems(list, search, 500).map((result) => result.item);
    }
    return list;
  }, [items.data, categoryId, stockFilter, search]);

  const stockWorth = useMemo(
    () =>
      canSeeCost
        ? (items.data ?? []).reduce(
            (sum, item) => sum + Math.round(item.qtyOnHand * (item.costPrice ?? 0)),
            0,
          )
        : null,
    [items.data, canSeeCost],
  );

  const lowCount = (items.data ?? []).filter(
    (item) => item.lowStockLevel > 0 && item.qtyOnHand <= item.lowStockLevel,
  ).length;

  function open(dialogName: Dialog, item: Item | null): void {
    setActive(item);
    setDialog(dialogName);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Items"
        subtitle={
          items.data
            ? `${items.data.length} items${stockWorth !== null ? ` — ${formatPKR(stockWorth)} of stock at cost` : ''}`
            : undefined
        }
        actions={
          canManage ? (
            <>
              {canManageStock && <Button onClick={() => open('count', null)}>Count stock</Button>}
              <Button onClick={() => open('categories', null)}>Categories</Button>
              <Button onClick={() => open('import', null)}>Bring in a list</Button>
              <Button variant="primary" onClick={() => open('edit', null)}>
                Add item
              </Button>
            </>
          ) : undefined
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or code" autoFocus />

        <Select value={categoryId} onChange={setCategoryId} label="Filter by category">
          <option value="all">All categories</option>
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name} ({category.itemCount})
            </option>
          ))}
          <option value="none">No category</option>
        </Select>

        <Select
          value={stockFilter}
          onChange={(value) => setStockFilter(value as StockFilter)}
          label="Filter by stock"
        >
          <option value="all">Any stock level</option>
          <option value="low">Running low{lowCount ? ` (${lowCount})` : ''}</option>
          <option value="out">Out of stock</option>
        </Select>

        <label className="ml-auto flex items-center gap-2 text-meta text-ink-soft">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
            className="size-3.5 accent-board"
          />
          Include items no longer sold
        </label>
      </Toolbar>

      {items.isPending && <p className="px-6 py-8 text-ink-soft">Loading…</p>}

      {items.data && rows.length === 0 && (
        <EmptyState
          title={search.trim() ? `Nothing matches “${search}”` : 'No items yet'}
          detail={
            search.trim()
              ? 'Try part of the name, or a different spelling.'
              : 'Add your first item, or bring in a list from Excel.'
          }
          {...(canManage && !search.trim()
            ? { action: <Button variant="primary" onClick={() => open('edit', null)}>Add item</Button> }
            : {})}
        />
      )}

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-rule-strong">
                <Th className="w-24 pl-6">Code</Th>
                <Th>Item</Th>
                <Th className="w-40">Category</Th>
                <Th align="right" className="w-28">In stock</Th>
                {canSeeCost && <Th align="right" className="w-28">Cost</Th>}
                <Th align="right" className="w-28">Price</Th>
                <Th align="right" className="w-52 pr-6">{' '}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const out = item.qtyOnHand <= 0;
                const low = !out && item.lowStockLevel > 0 && item.qtyOnHand <= item.lowStockLevel;
                return (
                  <tr key={item.id} className="group border-b border-rule hover:bg-surface">
                    <td className="tabular py-2.5 pl-6 text-meta text-ink-soft">{item.code}</td>
                    <td className="py-2.5 pr-4">
                      <span className="text-row text-ink">{item.name}</span>
                      {!item.isActive && (
                        <span className="ml-2 rounded bg-sunk px-1.5 py-0.5 text-micro text-ink-soft">
                          no longer sold
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-meta text-ink-soft">{item.categoryName ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <span
                        className={`tabular text-row ${out ? 'font-medium text-due' : low ? 'font-medium text-brass' : 'text-ink'}`}
                      >
                        {out ? 'none' : formatQty(item.qtyOnHand)}
                      </span>
                      {!out && <span className="ml-1 text-meta text-ink-faint">{item.unit}</span>}
                      {low && <span className="block text-micro text-brass">running low</span>}
                    </td>
                    {canSeeCost && (
                      <td className="tabular py-2.5 pr-4 text-right text-row text-ink-soft">
                        {formatPKR(item.costPrice ?? 0)}
                      </td>
                    )}
                    <td className="tabular py-2.5 pr-4 text-right text-row font-medium text-ink">
                      {formatPKR(item.salePrice)}
                    </td>
                    <td className="py-1.5 pr-6 text-right">
                      <span className="flex justify-end gap-1 opacity-55 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
                        <RowButton onClick={() => open('history', item)}>History</RowButton>
                        {canManageStock && (
                          <>
                            <RowButton onClick={() => open('stockIn', item)}>Stock in</RowButton>
                            <RowButton onClick={() => open('adjust', item)}>Adjust</RowButton>
                          </>
                        )}
                        {canManage && <RowButton onClick={() => open('edit', item)}>Edit</RowButton>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ItemEditorDialog
        open={dialog === 'edit'}
        item={active}
        canSeeCost={canSeeCost}
        onClose={() => setDialog('none')}
        onSaved={() => setDialog('none')}
      />
      <StockInDialog
        open={dialog === 'stockIn'}
        item={active}
        canSeeCost={canSeeCost}
        onClose={() => setDialog('none')}
      />
      <AdjustStockDialog open={dialog === 'adjust'} item={active} onClose={() => setDialog('none')} />
      <StockHistoryDialog
        open={dialog === 'history'}
        item={active}
        canSeeCost={canSeeCost}
        onClose={() => setDialog('none')}
      />
      <ImportItemsDialog open={dialog === 'import'} onClose={() => setDialog('none')} />
      <CategoriesDialog open={dialog === 'categories'} onClose={() => setDialog('none')} />
      <StockCountDialog open={dialog === 'count'} onClose={() => setDialog('none')} />
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
      className={`font-condensed py-2 text-meta font-medium text-ink-soft ${
        align === 'right' ? 'pr-4 text-right' : 'pr-4 text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}

function RowButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2 py-1 text-meta text-ink-soft transition-colors duration-100 hover:bg-sunk hover:text-ink focus:opacity-100"
    >
      {children}
    </button>
  );
}
