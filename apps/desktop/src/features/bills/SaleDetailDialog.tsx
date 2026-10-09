import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_METHOD_LABELS,
  formatDateTime,
  formatPKR,
  formatQty,
  parseQtyInput,
  type RefundMethod,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Sale } from '@/lib/api';
import { useSession } from '@/lib/session';

type Mode = 'view' | 'return' | 'void';

/**
 * One bill, in full.
 *
 * A saved bill is never edited in place: the customer is holding a copy, so
 * changing it would make the paper and the system disagree. Corrections happen
 * as a return or a cancellation, each recorded as its own event.
 */
export function SaleDetailDialog({
  open,
  saleId,
  onClose,
}: {
  open: boolean;
  saleId: string | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const { can } = useSession();
  const [mode, setMode] = useState<Mode>('view');

  const detail = useQuery({
    queryKey: ['sale', saleId],
    queryFn: () => api.sale(saleId!),
    enabled: open && Boolean(saleId),
  });

  // The PDF opens in whatever reads PDFs, ready to attach in WhatsApp.
  const receipt = useMutation({ mutationFn: () => api.saleReceipt(saleId!) });

  useEffect(() => {
    if (open) setMode('view');
  }, [open, saleId]);

  if (!saleId) return null;

  const sale = detail.data?.sale;
  const returns = detail.data?.returns ?? [];
  const returnable = sale?.lines.some((line) => line.qty - line.returnedQty > 0.0005) ?? false;

  if (mode === 'return' && sale) {
    return <ReturnDialog open={open} sale={sale} onClose={() => setMode('view')} />;
  }
  if (mode === 'void' && sale) {
    return <VoidDialog open={open} sale={sale} onClose={() => setMode('view')} onDone={onClose} />;
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={sale ? sale.invoiceNo : 'Bill'}
      {...(sale
        ? { description: `${formatDateTime(sale.soldAt)} — ${sale.userName}` }
        : {})}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {sale && (
            <Button onClick={() => receipt.mutate()} disabled={receipt.isPending}>
              {receipt.isPending ? 'Making PDF…' : 'Share bill'}
            </Button>
          )}
          {sale?.status === 'active' && can('sale.return') && returnable && (
            <Button onClick={() => setMode('return')}>Take a return</Button>
          )}
          {sale?.status === 'active' && can('sale.void') && (
            <Button variant="danger" onClick={() => setMode('void')}>
              Cancel bill
            </Button>
          )}
        </>
      }
    >
      {detail.isPending && <p className="text-ink-soft">Loading…</p>}

      {receipt.error instanceof ApiError && (
        <p className="mb-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {receipt.error.message}
        </p>
      )}

      {sale && (
        <>
          {sale.status === 'voided' && (
            <p className="mb-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
              This bill was cancelled. The stock went back and any udhaar was reversed.
            </p>
          )}

          <div className="flex flex-wrap gap-x-10 gap-y-2 border-b border-rule pb-4 text-base">
            <Fact label="Customer" value={sale.customerName ?? 'Walk-in'} />
            <Fact label="Paid by" value={PAYMENT_METHOD_LABELS[sale.paymentMethod]} />
            {sale.credit > 0 && (
              <Fact label="On udhaar" value={formatPKR(sale.credit)} tone="due" />
            )}
            {sale.profit !== null && <Fact label="Profit" value={formatPKR(sale.profit)} />}
          </div>

          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr className="border-b border-rule-strong">
                <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
                  Item
                </th>
                <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                  Qty
                </th>
                <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                  Rate
                </th>
                <th
                  scope="col"
                  className="font-condensed border-l border-rule-strong pb-2 pl-4 text-right text-meta font-medium text-ink-soft"
                >
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((line) => (
                <tr key={line.id} className="border-b border-rule">
                  <td className="py-2 pr-4">
                    <span className="text-base text-ink">{line.itemName}</span>
                    <span className="tabular ml-2 text-meta text-ink-faint">{line.itemCode}</span>
                    {line.returnedQty > 0 && (
                      <span className="block text-meta text-brass">
                        {formatQty(line.returnedQty)} returned
                      </span>
                    )}
                  </td>
                  <td className="tabular py-2 pr-4 text-right text-base text-ink">
                    {formatQty(line.qty)} <span className="text-ink-faint">{line.unit}</span>
                  </td>
                  <td className="tabular py-2 pr-4 text-right text-base text-ink">
                    {formatPKR(line.unitPrice)}
                  </td>
                  <td className="tabular border-l border-rule-strong py-2 pl-4 text-right text-base font-medium text-ink">
                    {formatPKR(line.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-4 ml-auto w-64 space-y-1.5 text-base">
            <Row label="Subtotal" value={formatPKR(sale.subtotal)} />
            {sale.discount > 0 && <Row label="Discount" value={`-${formatPKR(sale.discount)}`} />}
            {sale.rounding !== 0 && (
              <Row label="Rounding" value={`${sale.rounding > 0 ? '+' : ''}${formatPKR(sale.rounding)}`} />
            )}
            <div className="flex justify-between border-t border-rule pt-1.5 text-section font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{formatPKR(sale.total)}</dd>
            </div>
            <Row label="Paid" value={formatPKR(sale.paid)} />
            {sale.credit > 0 && <Row label="On udhaar" value={formatPKR(sale.credit)} tone="due" />}
          </dl>

          {returns.length > 0 && (
            <section className="mt-6 border-t border-rule pt-4">
              <h3 className="font-condensed text-meta font-medium text-ink-soft">Returns</h3>
              <ul className="mt-2 space-y-1.5">
                {returns.map((entry) => (
                  <li key={entry.id} className="flex items-baseline justify-between gap-4 text-base">
                    <span className="text-ink">
                      <span className="tabular">{entry.returnNo}</span>
                      <span className="ml-2 text-meta text-ink-soft">
                        {formatDateTime(entry.returnedAt)}
                        {entry.reason ? ` — ${entry.reason}` : ''}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-brass">{formatPKR(entry.total)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}

function ReturnDialog({
  open,
  sale,
  onClose,
}: {
  open: boolean;
  sale: Sale;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<RefundMethod>(sale.customerId ? 'credit_note' : 'cash');
  const [reason, setReason] = useState('');

  const lines = useMemo(
    () =>
      sale.lines
        .map((line) => ({ line, remaining: Math.round((line.qty - line.returnedQty) * 1000) / 1000 }))
        .filter((entry) => entry.remaining > 0.0005),
    [sale],
  );

  const chosen = lines
    .map((entry) => ({ entry, qty: parseQtyInput(quantities[entry.line.id] ?? '') }))
    .filter((row): row is { entry: (typeof lines)[number]; qty: number } => row.qty !== null);

  const refundTotal = chosen.reduce(
    (sum, row) => sum + Math.round(row.qty * row.entry.line.unitPrice),
    0,
  );

  const tooMany = chosen.find((row) => row.qty > row.entry.remaining + 0.0005);

  const save = useMutation({
    mutationFn: () =>
      api.createReturn({
        saleId: sale.id,
        lines: chosen.map((row) => ({ saleItemId: row.entry.line.id, qty: row.qty })),
        refundMethod: method,
        reason: reason.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sale'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
  });

  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Return against ${sale.invoiceNo}`}
      description="Enter how many of each item are coming back. The stock goes back on the shelf."
      width="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={chosen.length === 0 || Boolean(tooMany) || save.isPending}
          >
            {save.isPending ? 'Saving…' : `Return ${formatPKR(refundTotal)}`}
          </Button>
        </>
      }
    >
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule-strong">
            <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
              Item
            </th>
            <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
              Can return
            </th>
            <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
              Rate
            </th>
            <th scope="col" className="font-condensed w-32 pb-2 pl-4 text-right text-meta font-medium text-ink-soft">
              Returning
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ line, remaining }) => (
            <tr key={line.id} className="border-b border-rule">
              <td className="py-2 pr-4 text-base text-ink">{line.itemName}</td>
              <td className="tabular py-2 pr-4 text-right text-base text-ink-soft">
                {formatQty(remaining)} {line.unit}
              </td>
              <td className="tabular py-2 pr-4 text-right text-base text-ink-soft">
                {formatPKR(line.unitPrice)}
              </td>
              <td className="py-1.5 pl-4">
                <input
                  value={quantities[line.id] ?? ''}
                  onChange={(event) =>
                    setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`Quantity of ${line.itemName} being returned`}
                  className="tabular h-9 w-full rounded border border-rule-strong bg-surface px-2 text-right text-base focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {tooMany && (
        <p className="mt-3 text-meta text-due">
          Only {formatQty(tooMany.entry.remaining)} of {tooMany.entry.line.itemName} can still be
          returned.
        </p>
      )}

      <div className="mt-5 border-t border-rule pt-4">
        <span className="mb-1.5 block text-meta font-medium text-ink-soft">Refund by</span>
        <div className="grid grid-cols-4 gap-2">
          {(['cash', 'wallet', 'bank', 'credit_note'] as RefundMethod[]).map((option) => {
            const disabled = option === 'credit_note' && !sale.customerId;
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => setMethod(option)}
                className={`rounded border px-2 py-2 text-base transition-colors duration-100 disabled:cursor-not-allowed disabled:text-ink-faint ${
                  method === option
                    ? 'border-board bg-board-tint font-medium text-ink'
                    : 'border-rule-strong bg-surface text-ink-soft hover:border-ink-soft'
                }`}
              >
                {option === 'credit_note' ? 'Off their udhaar' : PAYMENT_METHOD_LABELS[option]}
              </button>
            );
          })}
        </div>
      </div>

      <Field
        className="mt-4"
        label="Why is it coming back"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Optional"
        maxLength={200}
      />

      {error && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}
    </Modal>
  );
}

function VoidDialog({
  open,
  sale,
  onClose,
  onDone,
}: {
  open: boolean;
  sale: Sale;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () => api.voidSale(sale.id, reason.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sale'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onDone();
    },
  });

  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Cancel ${sale.invoiceNo}?`}
      description="Nothing is deleted. The bill stays on record marked as cancelled."
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Keep the bill
          </Button>
          <Button
            variant="danger"
            onClick={() => save.mutate()}
            disabled={reason.trim().length < 3 || save.isPending}
          >
            {save.isPending ? 'Cancelling…' : 'Cancel this bill'}
          </Button>
        </>
      }
    >
      <ul className="mb-4 space-y-1 text-base text-ink-soft">
        <li>
          {sale.lines.length} {sale.lines.length === 1 ? 'item goes' : 'items go'} back into stock
        </li>
        {sale.credit > 0 && <li>{formatPKR(sale.credit)} comes off the customer&apos;s udhaar</li>}
        {sale.paid > 0 && <li>{formatPKR(sale.paid)} was taken and must be handed back by hand</li>}
      </ul>

      <Field
        label="Why is this being cancelled"
        data-autofocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Rung up twice"
        maxLength={200}
        hint="Recorded against your name."
      />

      {error && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}
    </Modal>
  );
}

function Fact({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'due';
}): React.JSX.Element {
  return (
    <div>
      <p className="text-meta text-ink-soft">{label}</p>
      <p className={`tabular ${tone === 'due' ? 'text-due' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'due';
}): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`tabular ${tone === 'due' ? 'text-due' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
