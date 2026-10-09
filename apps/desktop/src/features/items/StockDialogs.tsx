import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ADJUSTMENT_REASON_LABELS,
  formatDateTime,
  formatPKR,
  formatQty,
  parseMoneyInput,
  parseQtyInput,
  type AdjustmentReason,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Item } from '@/lib/api';

const MOVEMENT_LABELS: Record<string, string> = {
  opening: 'Opening stock',
  stock_in: 'Stock in',
  sale: 'Sold',
  return: 'Returned',
  adjustment: 'Adjusted',
};

/** Receive stock from a supplier. */
export function StockInDialog({
  open,
  item,
  canSeeCost,
  onClose,
}: {
  open: boolean;
  item: Item | null;
  canSeeCost: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [supplier, setSupplier] = useState('');

  useEffect(() => {
    if (open && item) {
      setQty('');
      setCost(item.costPrice === null ? '' : String(item.costPrice / 100));
      setSupplier('');
    }
  }, [open, item]);

  const save = useMutation({
    mutationFn: () =>
      api.stockIn({
        itemId: item!.id,
        qty: parseQtyInput(qty) ?? 0,
        unitCost: cost.trim() ? parseMoneyInput(cost) : null,
        supplierName: supplier.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['itemHistory'] });
      onClose();
    },
  });

  if (!item) return null;

  const parsedQty = parseQtyInput(qty);
  const parsedCost = parseMoneyInput(cost);
  const costChanged = parsedCost !== null && item.costPrice !== null && parsedCost !== item.costPrice;
  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Stock in"
      description={`${item.name} — ${formatQty(item.qtyOnHand)} ${item.unit} on hand`}
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={parsedQty === null || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Add to stock'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label={`How many ${item.unit} came in`}
          data-autofocus
          value={qty}
          onChange={(event) => setQty(event.target.value)}
          inputMode="decimal"
          hint={parsedQty !== null ? `Stock becomes ${formatQty(item.qtyOnHand + parsedQty)}` : undefined}
        />

        {canSeeCost && (
          <Field
            label="Cost per unit"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            inputMode="decimal"
            hint={
              costChanged
                ? `Replaces the old cost of ${formatPKR(item.costPrice ?? 0)}. Bills already made keep their old cost.`
                : 'Leave as it is if the price has not changed'
            }
          />
        )}

        <Field
          label="Supplier"
          value={supplier}
          onChange={(event) => setSupplier(event.target.value)}
          placeholder="Optional"
          maxLength={80}
        />

        {error && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Correct the recorded stock to what is actually on the shelf. */
export function AdjustStockDialog({
  open,
  item,
  onClose,
}: {
  open: boolean;
  item: Item | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState<AdjustmentReason>('correction');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open && item) {
      setCounted(formatQty(item.qtyOnHand));
      setReason('correction');
      setNote('');
    }
  }, [open, item]);

  const save = useMutation({
    mutationFn: () =>
      api.adjustStock({
        itemId: item!.id,
        countedQty: Number(counted),
        reason,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['itemHistory'] });
      onClose();
    },
  });

  if (!item) return null;

  const parsed = Number(counted);
  const valid = Number.isFinite(parsed) && parsed >= 0;
  const delta = valid ? Math.round((parsed - item.qtyOnHand) * 1000) / 1000 : 0;
  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Adjust stock"
      description="Count what is on the shelf. The difference is recorded with your reason."
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!valid || delta === 0 || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Record adjustment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-base text-ink-soft">
          {item.name} — recorded as{' '}
          <span className="tabular font-medium text-ink">
            {formatQty(item.qtyOnHand)} {item.unit}
          </span>
        </p>

        <Field
          label={`How many ${item.unit} are actually there`}
          data-autofocus
          value={counted}
          onChange={(event) => setCounted(event.target.value)}
          inputMode="decimal"
          hint={
            delta === 0
              ? 'Same as recorded — nothing to adjust'
              : `${delta > 0 ? 'Adding' : 'Removing'} ${formatQty(Math.abs(delta))} ${item.unit}`
          }
        />

        <div>
          <label htmlFor="reason" className="mb-1.5 block text-meta font-medium text-ink-soft">
            Why
          </label>
          <select
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value as AdjustmentReason)}
            className="h-10 w-full rounded border border-rule-strong bg-surface px-3 text-row text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
          >
            {(Object.keys(ADJUSTMENT_REASON_LABELS) as AdjustmentReason[]).map((value) => (
              <option key={value} value={value}>
                {ADJUSTMENT_REASON_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional"
          maxLength={200}
        />

        {error && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Everything that ever moved this item.
 *
 * This is the screen that answers "why is this at 3 and not 5?" — the question
 * the paper register could never settle.
 */
export function StockHistoryDialog({
  open,
  item,
  canSeeCost,
  onClose,
}: {
  open: boolean;
  item: Item | null;
  canSeeCost: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const history = useQuery({
    queryKey: ['itemHistory', item?.id],
    queryFn: () => api.itemHistory(item!.id),
    enabled: open && Boolean(item),
  });

  if (!item) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`History — ${item.name}`}
      description={`Now ${formatQty(item.qtyOnHand)} ${item.unit} in stock`}
      width="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {history.isPending && <p className="text-ink-soft">Loading…</p>}

      {history.data?.length === 0 && (
        <p className="text-ink-soft">Nothing has moved this item yet.</p>
      )}

      {history.data && history.data.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-rule-strong">
              <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
                When
              </th>
              <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
                What happened
              </th>
              <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                Change
              </th>
              <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                Left
              </th>
              <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                By
              </th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((row) => (
              <tr key={row.id} className="border-b border-rule">
                <td className="py-2 pr-4 text-meta whitespace-nowrap text-ink-soft">
                  {formatDateTime(row.createdAt)}
                </td>
                <td className="py-2 pr-4 text-base text-ink">
                  {MOVEMENT_LABELS[row.type] ?? row.type}
                  {row.refLabel && <span className="tabular ml-2 text-meta text-ink-soft">{row.refLabel}</span>}
                  {row.supplierName && <span className="ml-2 text-meta text-ink-soft">{row.supplierName}</span>}
                  {row.reason && <span className="ml-2 text-meta text-ink-faint">{row.reason}</span>}
                  {canSeeCost && row.unitCost !== null && (
                    <span className="tabular ml-2 text-meta text-ink-faint">
                      at {formatPKR(row.unitCost)}
                    </span>
                  )}
                </td>
                <td
                  className={`tabular py-2 text-right text-base font-medium ${
                    row.qtyDelta > 0 ? 'text-board' : 'text-due'
                  }`}
                >
                  {row.qtyDelta > 0 ? '+' : ''}
                  {formatQty(row.qtyDelta)}
                </td>
                <td className="tabular py-2 text-right text-base text-ink">{formatQty(row.qtyAfter)}</td>
                <td className="py-2 text-right text-meta text-ink-soft">{row.userName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
