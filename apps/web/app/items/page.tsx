'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatPKR, formatQty, parseMoneyInput, parseQtyInput } from '@pos/shared';
import { Field, Guarded } from '@/components/shell';
import { listItems, type ShopItem } from '@/lib/shop';
import { PushRefused, actingUserId, correctStock, repriceItem } from '@/lib/push';

/**
 * The catalogue, and the two things the owner wants to do to it from away
 * from the shop: change a price, and correct a count.
 *
 * Both go through the sync function rather than touching a table, so the
 * counter's rules apply to the owner exactly as they apply to a cashier — and
 * a count is sent as the difference it makes, never as the figure itself.
 */
export default function ItemsPage() {
  return (
    <Guarded>
      <Catalogue />
    </Guarded>
  );
}

function Catalogue() {
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ShopItem | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setItems(await listItems());
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The items could not be read.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    if (!items) return [];
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      (item) =>
        item.code.toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        (item.categoryName ?? '').toLowerCase().includes(term),
    );
  }, [items, search]);

  return (
    <main className="mt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-title font-semibold tracking-tight">Items</h1>
        {items && <p className="text-meta text-ink-faint">{items.length} in the shop</p>}
      </div>

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by name, code or category"
        className="mt-4 w-full rounded border border-rule bg-white px-3 py-2.5 text-row outline-none focus:border-board"
      />

      {problem && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3.5 py-3 text-row text-due">
          {problem}
        </p>
      )}

      {!items && !problem && <p className="mt-6 text-ink-soft">Loading…</p>}

      {items && shown.length === 0 && (
        <p className="mt-6 text-ink-soft">Nothing matches “{search.trim()}”.</p>
      )}

      <ul className="mt-4 divide-y divide-rule overflow-hidden rounded border border-rule bg-white">
        {shown.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => setEditing(item)}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-100 hover:bg-paper"
            >
              <span className="w-14 shrink-0 font-mono text-meta text-ink-faint">{item.code}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-row">{item.name}</span>
                <span className="block text-meta text-ink-faint">
                  {formatQty(item.qtyOnHand)} {item.unit}
                  {item.qtyOnHand <= item.lowStockLevel && item.qtyOnHand > 0 && ' · running low'}
                  {item.qtyOnHand <= 0 && ' · none left'}
                </span>
              </span>
              <span className="shrink-0 text-row font-medium tabular-nums">
                {formatPKR(item.salePrice)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <Editor
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function Editor({
  item,
  onClose,
  onSaved,
}: {
  item: ShopItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [price, setPrice] = useState((item.salePrice / 100).toString());
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('Counted on the shelf');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const newPrice = parseMoneyInput(price);
  const countedQty = counted.trim() === '' ? null : parseQtyInput(counted);

  const priceChanged = newPrice !== null && newPrice !== item.salePrice;
  const stockChanged = countedQty !== null && countedQty !== item.qtyOnHand;
  const canSave = (priceChanged || stockChanged) && !busy;

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      if (priceChanged && newPrice !== null) {
        await repriceItem({ id: item.id, salePrice: newPrice });
      }
      if (stockChanged && countedQty !== null) {
        if (reason.trim().length < 3) {
          throw new PushRefused('Say why the count is changing, so it makes sense later.');
        }
        await correctStock({
          itemId: item.id,
          countedQty,
          currentQty: item.qtyOnHand,
          reason: reason.trim(),
          userId: await actingUserId(),
        });
      }
      onSaved();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'That change was not saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end bg-ink/35 sm:items-center sm:justify-center">
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-paper p-5 sm:max-w-md sm:rounded-xl">
        <p className="font-mono text-meta text-ink-faint">{item.code}</p>
        <h2 className="mt-0.5 text-section font-semibold">{item.name}</h2>
        <p className="mt-0.5 text-meta text-ink-soft">
          {formatQty(item.qtyOnHand)} {item.unit} on the shelf · costs {formatPKR(item.costPrice)}
        </p>

        <div className="mt-5 space-y-4">
          <Field
            label="Selling price (Rs)"
            value={price}
            onChange={setPrice}
            inputMode="decimal"
            hint={
              newPrice === null
                ? 'That is not an amount.'
                : priceChanged
                  ? `Changing from ${formatPKR(item.salePrice)} to ${formatPKR(newPrice)}`
                  : 'Unchanged.'
            }
          />

          <div className="border-t border-rule pt-4">
            <Field
              label="Counted on the shelf"
              value={counted}
              onChange={setCounted}
              inputMode="decimal"
              hint={
                counted.trim() === ''
                  ? 'Leave empty unless you have counted it.'
                  : countedQty === null
                    ? 'That is not a quantity.'
                    : stockChanged
                      ? `${countedQty > item.qtyOnHand ? 'Adding' : 'Taking off'} ${formatQty(Math.abs(countedQty - item.qtyOnHand))} — anything sold at the counter meanwhile still counts.`
                      : 'Same as the record.'
              }
            />
            {stockChanged && (
              <div className="mt-4">
                <Field label="Why" value={reason} onChange={setReason} />
              </div>
            )}
          </div>
        </div>

        {problem && (
          <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {problem}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="flex-1 rounded bg-ink px-4 py-2.5 text-row font-medium text-white disabled:opacity-45"
          >
            {busy ? 'Saving…' : 'Save'}
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
      </div>
    </div>
  );
}
