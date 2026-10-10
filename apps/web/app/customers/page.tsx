'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DUE_BUCKET_LABELS,
  daysOutstanding,
  dueBucket,
  formatDate,
  formatPKR,
  parseMoneyInput,
  recomputeBalance,
  verifyLedger,
  type PaymentMethod,
} from '@pos/shared';
import { Field, Guarded } from '@/components/shell';
import { customerLedger, listCustomers, type LedgerLine, type ShopCustomer } from '@/lib/shop';
import { actingUserId, receivePayment } from '@/lib/push';

/**
 * Who owes the shop money, and taking a payment off it.
 *
 * The question the owner actually has is "who should I chase?", so the list
 * leads with what is owed and how long it has been owed for, not with
 * alphabetical order.
 */
export default function CustomersPage() {
  return (
    <Guarded>
      <Customers />
    </Guarded>
  );
}

function Customers() {
  const [customers, setCustomers] = useState<ShopCustomer[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<ShopCustomer | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setCustomers(await listCustomers());
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The customers could not be read.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { owing, settled, total } = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = (customers ?? []).filter(
      (customer) =>
        !term ||
        customer.name.toLowerCase().includes(term) ||
        (customer.phone ?? '').includes(term),
    );
    return {
      owing: matching.filter((customer) => customer.balance > 0).sort((a, b) => b.balance - a.balance),
      settled: matching.filter((customer) => customer.balance <= 0),
      total: (customers ?? []).reduce((sum, customer) => sum + Math.max(customer.balance, 0), 0),
    };
  }, [customers, search]);

  return (
    <main className="mt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-title font-semibold tracking-tight">Customers</h1>
        {customers && customers.length > 0 && (
          <p className="text-meta text-ink-faint">
            {formatPKR(total)} owed to the shop
          </p>
        )}
      </div>

      {customers && customers.length > 0 && (
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or phone"
          className="mt-4 w-full rounded border border-rule bg-white px-3 py-2.5 text-row outline-none focus:border-board"
        />
      )}

      {problem && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3.5 py-3 text-row text-due">
          {problem}
        </p>
      )}

      {!customers && !problem && <p className="mt-6 text-ink-soft">Loading…</p>}

      {customers?.length === 0 && (
        <div className="mt-6 rounded border border-rule bg-white px-4 py-6 text-center">
          <p className="text-row text-ink">Nobody has been added yet</p>
          <p className="mt-1 text-meta text-ink-soft">
            Customers are added at the counter, along with what they already owe from the register.
          </p>
        </div>
      )}

      {owing.length > 0 && (
        <section className="mt-5">
          <h2 className="text-meta font-medium text-ink-soft">Owing</h2>
          <ul className="mt-2 divide-y divide-rule overflow-hidden rounded border border-rule bg-white">
            {owing.map((customer) => (
              <Row key={customer.id} customer={customer} onOpen={() => setOpen(customer)} />
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="mt-5">
          <h2 className="text-meta font-medium text-ink-soft">Nothing owed</h2>
          <ul className="mt-2 divide-y divide-rule overflow-hidden rounded border border-rule bg-white">
            {settled.map((customer) => (
              <Row key={customer.id} customer={customer} onOpen={() => setOpen(customer)} />
            ))}
          </ul>
        </section>
      )}

      {open && (
        <Ledger
          customer={open}
          onClose={() => setOpen(null)}
          onPaid={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function Row({ customer, onOpen }: { customer: ShopCustomer; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-100 hover:bg-paper"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-row">{customer.name}</span>
          {customer.phone && <span className="block text-meta text-ink-faint">{customer.phone}</span>}
        </span>
        <span
          className={`shrink-0 text-row font-medium tabular-nums ${
            customer.balance > 0 ? 'text-due' : 'text-ink-faint'
          }`}
        >
          {customer.balance === 0 ? '—' : formatPKR(customer.balance)}
        </span>
      </button>
    </li>
  );
}

const METHODS: Array<{ id: PaymentMethod; label: string }> = [
  { id: 'cash', label: 'Cash' },
  { id: 'wallet', label: 'Easypaisa / JazzCash' },
  { id: 'bank', label: 'Bank transfer' },
];

function Ledger({
  customer,
  onClose,
  onPaid,
}: {
  customer: ShopCustomer;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [lines, setLines] = useState<LedgerLine[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setLines(await customerLedger(customer.id));
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : 'The history could not be read.');
      }
    })();
  }, [customer.id]);

  // The running balance is checked against the entries rather than trusted.
  // A ledger that does not add up is the one thing here worth saying out loud.
  const check = lines ? verifyLedger(lines.map((line) => ({ amount: line.amount, balanceAfter: line.balanceAfter }))) : null;
  const fromEntries = lines ? recomputeBalance(lines) : 0;

  const oldest = lines?.find((line) => line.amount > 0);
  const waiting = oldest ? daysOutstanding(oldest.entryDate) : 0;

  const paying = parseMoneyInput(amount);
  // Nothing may be recorded until the history has arrived. Before it does,
  // the balance reads as zero, and a payment sent against zero writes a
  // running total that is wrong by the whole debt — which is exactly what
  // happened the first time this was tried.
  const canPay = lines !== null && paying !== null && paying > 0 && !busy;

  async function pay() {
    if (paying === null || lines === null) return;
    setBusy(true);
    setProblem(null);
    try {
      // Read the history again rather than trusting what is on screen. It may
      // have been open a while, and the counter may have taken a payment in
      // the meantime. The balance itself is always the sum of the entries —
      // `balance_after` only exists so the history reads downward like a
      // register, so the freshest sum is the right one to carry.
      const current = recomputeBalance(await customerLedger(customer.id));

      await receivePayment({
        customerId: customer.id,
        amount: paying,
        currentBalance: current,
        method,
        userId: await actingUserId(),
      });
      onPaid();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The payment was not saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end bg-ink/35 sm:items-center sm:justify-center">
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-paper p-5 sm:max-w-lg sm:rounded-xl">
        <h2 className="text-section font-semibold">{customer.name}</h2>
        <p className="mt-0.5 text-meta text-ink-soft">
          {customer.balance > 0
            ? `${formatPKR(customer.balance)} owed${waiting > 0 ? ` · ${DUE_BUCKET_LABELS[dueBucket(waiting)].toLowerCase()}` : ''}`
            : 'Nothing owed'}
        </p>

        {check && !check.ok && (
          <p className="mt-3 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            This history does not add up — it comes to {formatPKR(check.computed)}. Show this to
            whoever set up the system.
          </p>
        )}

        {!lines && !problem && <p className="mt-4 text-ink-soft">Loading…</p>}

        {lines && lines.length === 0 && (
          <p className="mt-4 text-row text-ink-soft">Nothing on this account yet.</p>
        )}

        {lines && lines.length > 0 && (
          <ul className="mt-4 divide-y divide-rule overflow-hidden rounded border border-rule bg-white">
            {lines.map((line) => (
              <li key={line.id} className="flex items-baseline gap-3 px-3.5 py-2.5">
                <span className="w-20 shrink-0 text-meta text-ink-faint">
                  {formatDate(line.entryDate)}
                </span>
                <span className="min-w-0 flex-1 text-meta">
                  {line.refLabel ?? describe(line.type)}
                  {line.note && <span className="text-ink-faint"> · {line.note}</span>}
                </span>
                <span
                  className={`shrink-0 text-meta tabular-nums ${line.amount > 0 ? 'text-due' : 'text-kept'}`}
                >
                  {line.amount > 0 ? '+' : '−'}
                  {formatPKR(Math.abs(line.amount), { symbol: false })}
                </span>
                <span className="w-20 shrink-0 text-right text-meta font-medium tabular-nums">
                  {formatPKR(line.balanceAfter, { symbol: false })}
                </span>
              </li>
            ))}
          </ul>
        )}

        {customer.balance > 0 && (
          <div className="mt-5 border-t border-rule pt-4">
            <p className="text-meta font-medium text-ink-soft">Received a payment</p>
            <div className="mt-3">
              <Field
                label="Amount (Rs)"
                value={amount}
                onChange={setAmount}
                inputMode="decimal"
                hint={
                  lines === null
                    ? 'Reading the history…'
                    : amount.trim() === ''
                      ? 'What the customer handed over.'
                      : paying === null
                        ? 'That is not an amount.'
                        : paying > fromEntries
                          ? `More than the ${formatPKR(fromEntries)} owed — this will leave them in credit.`
                          : `Leaves ${formatPKR(fromEntries - paying)} owed`
                }
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {METHODS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setMethod(option.id)}
                  className={[
                    'rounded-full px-3 py-1.5 text-meta transition-colors duration-100',
                    option.id === method
                      ? 'bg-ink font-medium text-white'
                      : 'border border-rule bg-white text-ink-soft',
                  ].join(' ')}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {problem && (
          <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {problem}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          {customer.balance > 0 && (
            <button
              type="button"
              onClick={() => void pay()}
              disabled={!canPay}
              className="flex-1 rounded bg-ink px-4 py-2.5 text-row font-medium text-white disabled:opacity-45"
            >
              {busy ? 'Saving…' : 'Record the payment'}
            </button>
          )}
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

function describe(type: string): string {
  const words: Record<string, string> = {
    opening: 'Already owed when they were added',
    credit_sale: 'Bought on udhaar',
    payment: 'Paid',
    return_credit: 'Returned goods',
    adjustment: 'Corrected by hand',
  };
  return words[type] ?? type;
}
