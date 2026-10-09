import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPKR, formatTime } from '@pos/shared';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ApiError, api, type HeldSale } from '@/lib/api';

/** Shape of what a parked bill carries. Written by `BillingScreen`. */
export interface HeldPayload {
  lines: Array<{ itemId: string; qty: number; unitPrice: number; priceEdited: boolean }>;
  discount: number;
  customerId: string | null;
  customerName: string | null;
  total: number;
  itemCount: number;
}

export function parseHeld(held: HeldSale): HeldPayload | null {
  try {
    return JSON.parse(held.payloadJson) as HeldPayload;
  } catch {
    return null;
  }
}

/**
 * Bills parked while someone fetches their wallet.
 *
 * Recalling one removes it, so the same draft cannot end up on the screen twice
 * and be rung up twice.
 */
export function HeldBillsDialog({
  open,
  onRecall,
  onClose,
}: {
  open: boolean;
  onRecall: (held: HeldSale) => void;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const held = useQuery({ queryKey: ['heldSales'], queryFn: api.heldSales, enabled: open });

  const recall = useMutation({
    mutationFn: api.recallHeld,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['heldSales'] });
      onRecall(result);
    },
  });

  const discard = useMutation({
    mutationFn: api.discardHeld,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['heldSales'] }),
  });

  const error =
    recall.error instanceof ApiError
      ? recall.error.message
      : discard.error instanceof ApiError
        ? discard.error.message
        : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Parked bills"
      description="Bills you set aside to serve someone else."
      width="md"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {held.isPending && <p className="text-ink-soft">Loading…</p>}

      {held.data?.length === 0 && (
        <p className="py-6 text-center text-ink-soft">
          Nothing is parked. Press F7 while making a bill to set it aside.
        </p>
      )}

      {error && (
        <p className="mb-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}

      <ul className="divide-y divide-rule">
        {held.data?.map((entry) => {
          const payload = parseHeld(entry);
          return (
            <li key={entry.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-row text-ink">{entry.label}</p>
                <p className="text-meta text-ink-soft">
                  {formatTime(entry.createdAt)}
                  {payload
                    ? ` — ${payload.itemCount} ${payload.itemCount === 1 ? 'item' : 'items'}, ${formatPKR(payload.total)}`
                    : ' — could not be read'}
                  {payload?.customerName ? ` for ${payload.customerName}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  onClick={() => discard.mutate(entry.id)}
                  disabled={discard.isPending}
                  variant="quiet"
                >
                  Discard
                </Button>
                <Button
                  variant="primary"
                  onClick={() => recall.mutate(entry.id)}
                  disabled={recall.isPending || !payload}
                >
                  Bring it back
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
