import { useCallback, useMemo, useRef, useState } from 'react';
import { computeSaleTotals, type DraftLine } from '@pos/shared';
import type { Customer, Item } from '@/lib/api';

export interface CartLine {
  /** Stable key for React and for selecting a row; not the item id. */
  key: string;
  item: Item;
  qty: number;
  unitPrice: number;
  /** True once the cashier has changed the rate, so it is not silently merged. */
  priceEdited: boolean;
}

let counter = 0;
const nextKey = (): string => `line-${++counter}`;

/**
 * The bill being built at the counter.
 *
 * Lives only in the renderer; nothing here is authoritative. The totals shown
 * are computed with the same functions the main process uses when it saves, so
 * what the cashier reads out to the customer is what gets stored.
 */
export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [discount, setDiscount] = useState(0);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [landedKey, setLandedKey] = useState<string | null>(null);
  const landedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Briefly mark a row so the cashier can confirm it landed without looking up. */
  const flash = useCallback((key: string) => {
    setLandedKey(key);
    if (landedTimer.current) clearTimeout(landedTimer.current);
    landedTimer.current = setTimeout(() => setLandedKey(null), 500);
  }, []);

  /**
   * Add an item, or add to the line that is already there.
   *
   * Scanning the same code twice should make it "2", not two rows of one —
   * except where the rate was changed by hand, which is a deliberately
   * different line and must not be merged into.
   */
  const addItem = useCallback(
    (item: Item, qty = 1) => {
      setLines((current) => {
        const existing = current.find(
          (line) => line.item.id === item.id && !line.priceEdited,
        );

        if (existing) {
          setSelectedKey(existing.key);
          flash(existing.key);
          return current.map((line) =>
            line.key === existing.key ? { ...line, qty: round3(line.qty + qty) } : line,
          );
        }

        const line: CartLine = {
          key: nextKey(),
          item,
          qty: round3(qty),
          unitPrice: item.salePrice,
          priceEdited: false,
        };
        setSelectedKey(line.key);
        flash(line.key);
        return [...current, line];
      });
    },
    [flash],
  );

  const setQty = useCallback((key: string, qty: number) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, qty: round3(qty) } : line)),
    );
  }, []);

  const bumpQty = useCallback((key: string, delta: number) => {
    setLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, qty: Math.max(round3(line.qty + delta), 0.001) } : line,
      ),
    );
  }, []);

  const setPrice = useCallback((key: string, unitPrice: number) => {
    setLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, unitPrice, priceEdited: unitPrice !== line.item.salePrice } : line,
      ),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((current) => {
      const index = current.findIndex((line) => line.key === key);
      const next = current.filter((line) => line.key !== key);
      setSelectedKey(next[Math.min(index, next.length - 1)]?.key ?? null);
      return next;
    });
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      setLines((current) => {
        if (current.length === 0) return current;
        const index = current.findIndex((line) => line.key === selectedKey);
        const nextIndex = Math.min(Math.max((index === -1 ? 0 : index) + delta, 0), current.length - 1);
        setSelectedKey(current[nextIndex]!.key);
        return current;
      });
    },
    [selectedKey],
  );

  const clear = useCallback(() => {
    setLines([]);
    setSelectedKey(null);
    setDiscount(0);
    setCustomer(null);
    setLandedKey(null);
  }, []);

  /** Replace the whole bill, for recalling a parked one. */
  const replace = useCallback(
    (next: { lines: CartLine[]; discount: number; customer: Customer | null }) => {
      setLines(next.lines);
      setDiscount(next.discount);
      setCustomer(next.customer);
      setSelectedKey(next.lines[next.lines.length - 1]?.key ?? null);
    },
    [],
  );

  const totals = useMemo(() => {
    const draft: DraftLine[] = lines.map((line) => ({
      itemId: line.item.id,
      itemCode: line.item.code,
      itemName: line.item.name,
      unit: line.item.unit,
      qty: line.qty,
      unitPrice: line.unitPrice,
      // Cost is not known here for a staff account, and is not needed: the
      // main process recomputes it from the database when the bill is saved.
      costPrice: line.item.costPrice ?? 0,
      minPrice: line.item.minPrice,
      qtyOnHand: line.item.qtyOnHand,
    }));
    return computeSaleTotals(draft, discount);
  }, [lines, discount]);

  const selected = lines.find((line) => line.key === selectedKey) ?? null;

  return {
    lines,
    selected,
    selectedKey,
    setSelectedKey,
    landedKey,
    discount,
    setDiscount,
    customer,
    setCustomer,
    totals,
    addItem,
    setQty,
    bumpQty,
    setPrice,
    removeLine,
    moveSelection,
    clear,
    replace,
    isEmpty: lines.length === 0,
  };
}

export type Cart = ReturnType<typeof useCart>;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
