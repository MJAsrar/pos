import { useMemo, useState } from 'react';
import { formatPKR, formatQty } from '@pos/shared';
import { ItemPhoto } from '@/components/ItemPhoto';
import type { Category, Item } from '@/lib/api';

interface CategoryBrowserProps {
  categories: Category[];
  items: Item[];
  onPick: (item: Item) => void;
  /** Keeps the chosen bin open between visits to this panel. */
  openCategoryId: string | null;
  onOpenCategory: (categoryId: string | null) => void;
}

const UNFILED = '__unfiled__';

/**
 * Browsing the shelves.
 *
 * Laid out like the labelled parts bins behind the counter: pick a bin, see
 * what is in it, tap what you want. This is the path for anyone who has not yet
 * memorised the codes — new staff, or the owner reaching for something from a
 * category they sell twice a month.
 *
 * Tapping a part adds it and stays where it is, because fetching four things
 * out of the same bin is one job, not four.
 */
export function CategoryBrowser({
  categories,
  items,
  onPick,
  openCategoryId,
  onOpenCategory,
}: CategoryBrowserProps): React.JSX.Element {
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      const key = item.categoryId ?? UNFILED;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const unfiledCount = counts.get(UNFILED) ?? 0;

  const openCategory = categories.find((category) => category.id === openCategoryId);
  const isUnfiled = openCategoryId === UNFILED;

  const shown = useMemo(() => {
    if (!openCategoryId) return [];
    return items
      .filter((item) =>
        isUnfiled ? item.categoryId === null : item.categoryId === openCategoryId,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, openCategoryId, isUnfiled]);

  // Show the picture column only when this bin actually has pictures. A grid
  // of empty grey squares is worse than no pictures at all.
  const showPhotos = shown.some((item) => item.photoPath);

  function pick(item: Item): void {
    onPick(item);
    setJustAdded(item.id);
    window.setTimeout(() => setJustAdded((current) => (current === item.id ? null : current)), 600);
  }

  // --- Inside a bin ---------------------------------------------------------

  if (openCategoryId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-4 flex items-baseline gap-3">
          <button
            type="button"
            onClick={() => onOpenCategory(null)}
            className="rounded px-2 py-1 text-base text-ink-soft transition-colors duration-100 hover:bg-sunk hover:text-ink"
          >
            ← All categories
          </button>
          <h2 className="text-section font-semibold text-ink">
            {isUnfiled ? 'No category' : (openCategory?.name ?? 'Category')}
          </h2>
          <span className="text-meta text-ink-soft">
            {shown.length} {shown.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        {shown.length === 0 ? (
          <p className="py-10 text-center text-ink-soft">
            Nothing in this category yet. Add items on the Items screen.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
            {shown.map((item) => {
              const out = item.qtyOnHand <= 0;
              const low = !out && item.lowStockLevel > 0 && item.qtyOnHand <= item.lowStockLevel;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => pick(item)}
                  className={[
                    'flex min-h-20 flex-col justify-between rounded border bg-surface px-3 py-2.5 text-left',
                    'transition-colors duration-100 hover:border-board hover:bg-board-tint',
                    item.id === justAdded ? 'border-board bg-board-tint' : 'border-rule-strong',
                  ].join(' ')}
                >
                  <span className="flex items-start gap-2.5">
                    {showPhotos && (
                      <ItemPhoto itemId={item.id} hasPhoto={Boolean(item.photoPath)} size={40} />
                    )}
                    <span className="min-w-0 flex-1 text-base leading-snug text-ink">
                      {item.name}
                    </span>
                  </span>
                  <span className="mt-1.5 flex items-baseline justify-between gap-2">
                    <span
                      className={`tabular text-meta ${
                        out ? 'text-due' : low ? 'text-brass' : 'text-ink-faint'
                      }`}
                    >
                      {out ? 'none left' : `${formatQty(item.qtyOnHand)} ${item.unit}`}
                    </span>
                    <span className="tabular text-row font-medium text-ink">
                      {formatPKR(item.salePrice)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // --- The bins themselves --------------------------------------------------

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {categories.map((category) => (
          <Bin
            key={category.id}
            name={category.name}
            count={counts.get(category.id) ?? 0}
            onClick={() => onOpenCategory(category.id)}
          />
        ))}

        {unfiledCount > 0 && (
          <Bin name="No category" count={unfiledCount} onClick={() => onOpenCategory(UNFILED)} muted />
        )}
      </div>

      {categories.length === 0 && (
        <p className="py-10 text-center text-ink-soft">
          No categories yet. Add them on the Items screen, under Categories.
        </p>
      )}
    </div>
  );
}

/**
 * One bin front.
 *
 * The green edge is the label clip — it is what makes a wall of these read as
 * drawers rather than as a grid of boxes.
 */
function Bin({
  name,
  count,
  onClick,
  muted = false,
}: {
  name: string;
  count: number;
  onClick: () => void;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group relative flex min-h-20 flex-col justify-between overflow-hidden rounded',
        'border border-rule-strong bg-surface py-3 pl-4 pr-3 text-left',
        'transition-colors duration-100 hover:border-ink-soft hover:bg-sunk',
      ].join(' ')}
    >
      <span
        className={`absolute inset-y-0 left-0 w-1 ${muted ? 'bg-rule-strong' : 'bg-board'}`}
        aria-hidden="true"
      />
      <span className="text-row leading-snug font-medium text-ink">{name}</span>
      <span className="tabular mt-1 text-meta text-ink-soft">
        {count === 0 ? 'empty' : `${count} ${count === 1 ? 'item' : 'items'}`}
      </span>
    </button>
  );
}
