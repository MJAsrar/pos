import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEDGER_ENTRY_LABELS,
  PAYMENT_METHOD_LABELS,
  daysOutstanding,
  formatDate,
  formatPKR,
  parseMoneyInput,
  type SettledMethod,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Customer } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * A customer's khata.
 *
 * Entries read downward with a running balance, the way the paper register
 * does — because the owner already knows how to read that, and because a
 * balance you can follow line by line is a balance you can argue from.
 */
export function CustomerLedgerDialog({
  open,
  customerId,
  onClose,
}: {
  open: boolean;
  customerId: string | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const { can } = useSession();
  const [paying, setPaying] = useState(false);
  const statement = useMutation({ mutationFn: () => api.customerStatement(customerId!) });

  const ledger = useQuery({
    queryKey: ['customerLedger', customerId],
    queryFn: () => api.customerLedger(customerId!),
    enabled: open && Boolean(customerId),
  });

  useEffect(() => {
    if (open) setPaying(false);
  }, [open, customerId]);

  if (!customerId) return null;

  const customer = ledger.data?.customer;
  const entries = ledger.data?.entries ?? [];
  const oldest = entries.find((entry) => entry.amount > 0);

  if (paying && customer) {
    return (
      <ReceivePaymentDialog
        open={open}
        customer={customer}
        onClose={() => setPaying(false)}
        onDone={() => setPaying(false)}
      />
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={customer?.name ?? 'Customer'}
      {...(customer?.phone ? { description: customer.phone } : {})}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {customer && (
            <Button onClick={() => statement.mutate()} disabled={statement.isPending}>
              {statement.isPending ? 'Making PDF…' : 'Send statement'}
            </Button>
          )}
          {can('customer.payment') && customer && customer.balance > 0 && (
            <Button variant="primary" onClick={() => setPaying(true)}>
              Receive payment
            </Button>
          )}
        </>
      }
    >
      {ledger.isPending && <p className="text-ink-soft">Loading…</p>}

      {customer && (
        <>
          <div className="flex items-baseline justify-between gap-6 border-b border-rule pb-4">
            <div>
              <p className="text-meta text-ink-soft">
                {customer.balance > 0
                  ? 'Owes the shop'
                  : customer.balance < 0
                    ? 'Paid in advance'
                    : 'Account is clear'}
              </p>
              <p
                className={`tabular mt-0.5 text-title font-semibold ${
                  customer.balance > 0 ? 'text-due' : customer.balance < 0 ? 'text-board' : 'text-ink'
                }`}
              >
                {formatPKR(Math.abs(customer.balance))}
              </p>
            </div>
            {customer.balance > 0 && oldest && (
              <p className="text-meta text-ink-soft">
                Oldest unpaid amount is {daysOutstanding(oldest.entryDate)} days old
              </p>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="py-8 text-center text-ink-soft">Nothing on this account yet.</p>
          ) : (
            <table className="mt-4 w-full border-collapse">
              <thead>
                <tr className="border-b border-rule-strong">
                  <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
                    Date
                  </th>
                  <th scope="col" className="font-condensed pb-2 text-left text-meta font-medium text-ink-soft">
                    What happened
                  </th>
                  <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                    Charged
                  </th>
                  <th scope="col" className="font-condensed pb-2 text-right text-meta font-medium text-ink-soft">
                    Paid
                  </th>
                  <th
                    scope="col"
                    className="font-condensed border-l border-rule-strong pb-2 pl-4 text-right text-meta font-medium text-ink-soft"
                  >
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-rule">
                    <td className="py-2 pr-4 text-meta whitespace-nowrap text-ink-soft">
                      {formatDate(entry.entryDate)}
                    </td>
                    <td className="py-2 pr-4 text-base text-ink">
                      {LEDGER_ENTRY_LABELS[entry.type]}
                      {entry.refLabel && (
                        <span className="tabular ml-2 text-meta text-ink-soft">{entry.refLabel}</span>
                      )}
                      {entry.note && (
                        <span className="block text-meta text-ink-faint">{entry.note}</span>
                      )}
                    </td>
                    <td className="tabular py-2 pr-4 text-right text-base text-ink">
                      {entry.amount > 0 ? formatPKR(entry.amount) : ''}
                    </td>
                    <td className="tabular py-2 pr-4 text-right text-base text-board">
                      {entry.amount < 0 ? formatPKR(-entry.amount) : ''}
                    </td>
                    <td
                      className={`tabular border-l border-rule-strong py-2 pl-4 text-right text-base font-medium ${
                        entry.balanceAfter > 0 ? 'text-due' : 'text-ink'
                      }`}
                    >
                      {formatPKR(entry.balanceAfter)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}

function ReceivePaymentDialog({
  open,
  customer,
  onClose,
  onDone,
}: {
  open: boolean;
  customer: Customer;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(String(Math.round(customer.balance / 100)));
  const [method, setMethod] = useState<SettledMethod>('cash');
  const [note, setNote] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.receivePayment({
        customerId: customer.id,
        amount: parseMoneyInput(amount) ?? 0,
        method,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['customerLedger'] });
      void queryClient.invalidateQueries({ queryKey: ['dues'] });
      onDone();
    },
  });

  const parsed = parseMoneyInput(amount);
  const valid = parsed !== null && parsed > 0;
  const remaining = valid ? customer.balance - parsed : customer.balance;
  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Receive payment"
      description={`${customer.name} owes ${formatPKR(customer.balance)}`}
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!valid || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Record payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Amount received"
          data-autofocus
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          onFocus={(event) => event.target.select()}
          inputMode="decimal"
          hint={
            valid
              ? remaining > 0
                ? `${formatPKR(remaining)} will still be owed`
                : remaining === 0
                  ? 'This clears the account'
                  : `${formatPKR(-remaining)} will be in credit`
              : undefined
          }
        />

        <div>
          <span className="mb-1.5 block text-meta font-medium text-ink-soft">Paid by</span>
          <div className="grid grid-cols-3 gap-2">
            {(['cash', 'wallet', 'bank'] as SettledMethod[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMethod(option)}
                className={`rounded border px-2 py-2 text-base transition-colors duration-100 ${
                  method === option
                    ? 'border-board bg-board-tint font-medium text-ink'
                    : 'border-rule-strong bg-surface text-ink-soft hover:border-ink-soft'
                }`}
              >
                {PAYMENT_METHOD_LABELS[option]}
              </button>
            ))}
          </div>
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
