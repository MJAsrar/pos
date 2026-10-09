import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPKR, formatQty } from '@pos/shared';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { searchItems } from '@/lib/search';
import type { Item } from '@/lib/api';

interface ItemSearchDialogProps {
  open: boolean;
  items: Item[];
  /** Whatever was already typed in the billing search box. */
  initialQuery: string;
  /** Whether this user may add an item mid-sale. */
  canAddItem: boolean;
  onPick: (item: Item) => void;
  /** Open the quick-add form, carrying whatever has been typed so far. */
  onCreate: (name: string) => void;
  onClose: () => void;
}

/**
 * Find an item by name when the code is not known.
 *
 * Opens pre-filled with whatever was already typed, so nothing has to be
 * retyped. Arrow keys move, Enter adds, Escape goes back to the bill.
 */
export function ItemSearchDialog({
  open,
  items,
  initialQuery,
  canAddItem,
  onPick,
  onCreate,
  onClose,
}: ItemSearchDialogProps): React.JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setIndex(0);
    }
  }, [open, initialQuery]);

  const results = useMemo(
    () => (query.trim() ? searchItems(items, query, 60) : items.slice(0, 60).map((item) => ({ item, score: 0 }))),
    [items, query],
  );

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(results.length - 1, 0)));
  }, [results.length]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  function handleKey(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = results[index]?.item;
      if (picked) onPick(picked);
      // Nothing matched: Enter goes straight to adding it, which is almost
      // always what the next keystroke was going to be anyway.
      else if (canAddItem && query.trim()) onCreate(query.trim());
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Find an item" width="lg">
      <input
        data-autofocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKey}
        placeholder="Type a name or code"
        className="h-11 w-full rounded border border-rule-strong bg-surface px-3 text-row focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
      />

      {results.length === 0 ? (
        <div className="mt-6 text-center">
          <p className="text-ink-soft">
            Nothing matches “{query}”. Try part of the name, or a different spelling.
          </p>
          {canAddItem && query.trim() && (
            <Button
              variant="primary"
              className="mt-4"
              onClick={() => onCreate(query.trim())}
              shortcut="Enter"
            >
              Add “{query.trim()}” as a new item
            </Button>
          )}
        </div>
      ) : (
        <ul ref={listRef} className="mt-4 max-h-96 divide-y divide-rule overflow-y-auto border-y border-rule">
          {results.map(({ item }, position) => {
            const active = position === index;
            const outOfStock = item.qtyOnHand <= 0;
            return (
              <li key={item.id} data-active={active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => onPick(item)}
                  className={`flex w-full items-baseline gap-4 px-3 py-2.5 text-left ${
                    active ? 'bg-board-tint' : ''
                  }`}
                >
                  <span className="font-condensed w-16 shrink-0 tabular text-meta text-ink-soft">
                    {item.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-row text-ink">{item.name}</span>
                  <span
                    className={`tabular w-24 shrink-0 text-right text-meta ${
                      outOfStock ? 'text-due' : 'text-ink-soft'
                    }`}
                  >
                    {outOfStock ? 'none left' : `${formatQty(item.qtyOnHand)} ${item.unit}`}
                  </span>
                  <span className="tabular w-24 shrink-0 text-right text-row font-medium text-ink">
                    {formatPKR(item.salePrice)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-meta text-ink-faint">Arrow keys to move, Enter to add, Esc to go back.</p>
        {canAddItem && results.length > 0 && (
          <Button variant="quiet" onClick={() => onCreate(query.trim())}>
            Not here? Add it
          </Button>
        )}
      </div>
    </Modal>
  );
}
