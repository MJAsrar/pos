import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatQty, parseQtyInput } from '@pos/shared';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Item } from '@/lib/api';

/**
 * Counting the shelves.
 *
 * One row per item with the recorded figure beside an empty box: walk the
 * shelf, type what is actually there, move on with Enter. Only the rows you
 * type into change anything — a blank box means "I did not count this", which
 * is different from counting zero and must not be treated as it.
 *
 * Working one category at a time matches how a shop is actually counted, and
 * keeps the list short enough to finish.
 */
export function StockCountDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [categoryId, setCategoryId] = useState('all');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ adjusted: number; unchanged: number } | null>(null);
  const rowRefs = useRef<Array<HTMLInputElement | null>>([]);

  const items = useQuery({ queryKey: ['items'], queryFn: () => api.items(), enabled: open });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories, enabled: open });

  useEffect(() => {
    if (open) {
      setCounts({});
      setDone(null);
      setCategoryId('all');
    }
  }, [open]);

  const rows = useMemo(() => {
    const all = items.data ?? [];
    const filtered =
      categoryId === 'all'
        ? all
        : all.filter((item) =>
            categoryId === 'none' ? item.categoryId === null : item.categoryId === categoryId,
          );
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [items.data, categoryId]);

  /** Only rows actually typed into, and only where the number differs. */
  const pending = useMemo(() => {
    const out: Array<{ item: Item; countedQty: number }> = [];
    for (const item of rows) {
      const raw = counts[item.id];
      if (raw === undefined || raw.trim() === '') continue;
      const parsed = raw.trim() === '0' ? 0 : parseQtyInput(raw);
      if (parsed === null) continue;
      if (parsed !== item.qtyOnHand) out.push({ item, countedQty: parsed });
    }
    return out;
  }, [rows, counts]);

  const typedButInvalid = rows.filter((item) => {
    const raw = counts[item.id];
    if (raw === undefined || raw.trim() === '') return false;
    return raw.trim() !== '0' && parseQtyInput(raw) === null;
  });

  const save = useMutation({
    mutationFn: () =>
      api.countStock(pending.map((row) => ({ itemId: row.item.id, countedQty: row.countedQty }))),
    onSuccess: (result) => {
      setDone(result);
      setCounts({});
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['report'] });
    },
  });

  const error = save.error instanceof ApiError ? save.error.message : undefined;

  function moveTo(index: number): void {
    rowRefs.current[index]?.focus();
    rowRefs.current[index]?.select();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Count stock"
      description="Type what is actually on the shelf. Leave a box empty for anything you have not counted."
      width="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {done ? 'Done' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={pending.length === 0 || typedButInvalid.length > 0 || save.isPending}
          >
            {save.isPending
              ? 'Saving…'
              : pending.length === 0
                ? 'Nothing to change'
                : `Correct ${pending.length} ${pending.length === 1 ? 'item' : 'items'}`}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          aria-label="Count one category at a time"
          className="h-9 rounded border border-rule-strong bg-surface px-2 text-base text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
        >
          <option value="all">Everything ({items.data?.length ?? 0})</option>
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name} ({category.itemCount})
            </option>
          ))}
          <option value="none">No category</option>
        </select>

        <span className="text-meta text-ink-soft">
          {pending.length === 0
            ? 'Nothing counted yet'
            : `${pending.length} ${pending.length === 1 ? 'figure' : 'figures'} will change`}
        </span>
      </div>

      {done && (
        <p className="mb-3 rounded border border-board/30 bg-board-tint px-3 py-2.5 text-meta text-board">
          Corrected {done.adjusted} {done.adjusted === 1 ? 'item' : 'items'}
          {done.unchanged > 0 ? `, ${done.unchanged} already matched` : ''}. Carry on with another
          category, or press Done.
        </p>
      )}

      {error && (
        <p className="mb-3 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}

      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-rule-strong">
            <th scope="col" className="font-condensed w-20 pb-2 text-left text-meta font-medium text-ink-soft">
              Code
            </th>
            <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
              Item
            </th>
            <th scope="col" className="font-condensed w-28 pb-2 pr-4 text-right text-meta font-medium text-ink-soft">
              Recorded
            </th>
            <th scope="col" className="font-condensed w-32 pb-2 text-right text-meta font-medium text-ink-soft">
              Counted
            </th>
            <th scope="col" className="font-condensed w-24 pb-2 pl-3 text-right text-meta font-medium text-ink-soft">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item, index) => {
            const raw = counts[item.id] ?? '';
            const parsed = raw.trim() === '' ? null : raw.trim() === '0' ? 0 : parseQtyInput(raw);
            const bad = raw.trim() !== '' && parsed === null;
            const delta = parsed === null ? null : Math.round((parsed - item.qtyOnHand) * 1000) / 1000;

            return (
              <tr key={item.id} className="border-b border-rule">
                <td className="tabular py-1.5 text-meta text-ink-soft">{item.code}</td>
                <td className="py-1.5 pr-4 text-base text-ink">{item.name}</td>
                <td className="tabular py-1.5 pr-4 text-right text-base text-ink-soft">
                  {formatQty(item.qtyOnHand)} <span className="text-ink-faint">{item.unit}</span>
                </td>
                <td className="py-1 pl-2">
                  <input
                    ref={(element) => {
                      rowRefs.current[index] = element;
                    }}
                    value={raw}
                    onChange={(event) =>
                      setCounts((current) => ({ ...current, [item.id]: event.target.value }))
                    }
                    onFocus={(event) => event.target.select()}
                    onKeyDown={(event) => {
                      // Enter and the arrows walk the list, so a whole shelf is
                      // one unbroken run of typing.
                      if (event.key === 'Enter' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        moveTo(Math.min(index + 1, rows.length - 1));
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        moveTo(Math.max(index - 1, 0));
                      }
                    }}
                    inputMode="decimal"
                    placeholder="—"
                    aria-label={`Counted quantity for ${item.name}`}
                    className={`tabular h-8 w-full rounded border bg-surface px-2 text-right text-base focus:outline-none focus:ring-2 focus:ring-board/20 ${
                      bad ? 'border-due' : 'border-rule-strong focus:border-board'
                    }`}
                  />
                </td>
                <td className="tabular py-1.5 pl-3 text-right text-meta">
                  {delta === null || delta === 0 ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <span className={delta > 0 ? 'text-board' : 'text-due'}>
                      {delta > 0 ? '+' : ''}
                      {formatQty(delta)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="py-8 text-center text-ink-soft">No items in this category.</p>
      )}
    </Modal>
  );
}
