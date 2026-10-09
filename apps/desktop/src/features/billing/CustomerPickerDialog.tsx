import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPKR } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Customer } from '@/lib/api';

interface CustomerPickerDialogProps {
  open: boolean;
  canAddCustomer: boolean;
  onPick: (customer: Customer | null) => void;
  onClose: () => void;
}

/**
 * Attach a customer to the bill.
 *
 * Doubles as the place to add one, because the moment you discover a customer
 * is not in the system is the moment they are standing at the counter wanting
 * to buy on udhaar.
 */
export function CustomerPickerDialog({
  open,
  canAddCustomer,
  onPick,
  onClose,
}: CustomerPickerDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [index, setIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.customers(),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setSearch('');
      setIndex(0);
      setAdding(false);
      setNewName('');
      setNewPhone('');
    }
  }, [open]);

  const results = useMemo(() => {
    const all = customers.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (customer) =>
        customer.name.toLowerCase().includes(needle) || (customer.phone ?? '').includes(needle),
    );
  }, [customers.data, search]);

  const create = useMutation({
    mutationFn: () =>
      api.createCustomer({
        name: newName.trim(),
        phone: newPhone.trim() || null,
        address: null,
        notes: null,
      }),
    onSuccess: (customer) => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onPick(customer);
    },
  });

  function handleKey(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = results[index];
      if (picked) onPick(picked);
    }
  }

  if (adding) {
    const error = create.error instanceof ApiError ? create.error.message : undefined;
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Add a customer"
        description="Just a name is enough for now. You can fill in the rest later."
        width="sm"
        footer={
          <>
            <Button onClick={() => setAdding(false)} disabled={create.isPending}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={newName.trim().length < 2 || create.isPending}
            >
              {create.isPending ? 'Saving…' : 'Add and use'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Name"
            data-autofocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            maxLength={80}
            error={error}
          />
          <Field
            label="Phone number"
            value={newPhone}
            onChange={(event) => setNewPhone(event.target.value)}
            inputMode="tel"
            placeholder="0300 1234567"
            maxLength={40}
          />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a customer"
      width="md"
      footer={
        <>
          <Button onClick={() => onPick(null)}>Walk-in customer</Button>
          {canAddCustomer && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add new
            </Button>
          )}
        </>
      }
    >
      <input
        data-autofocus
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setIndex(0);
        }}
        onKeyDown={handleKey}
        placeholder="Search by name or phone"
        className="h-11 w-full rounded border border-rule-strong bg-surface px-3 text-row focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
      />

      {customers.isPending && <p className="mt-6 text-ink-soft">Loading…</p>}

      {results.length === 0 && !customers.isPending && (
        <p className="mt-6 text-center text-ink-soft">
          {search.trim() ? `No customer matches “${search}”.` : 'No customers yet.'}
        </p>
      )}

      <ul className="mt-4 max-h-80 divide-y divide-rule overflow-y-auto border-y border-rule">
        {results.map((customer, position) => (
          <li key={customer.id}>
            <button
              type="button"
              tabIndex={-1}
              onMouseEnter={() => setIndex(position)}
              onClick={() => onPick(customer)}
              className={`flex w-full items-baseline justify-between gap-4 px-3 py-2.5 text-left ${
                position === index ? 'bg-board-tint' : ''
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-row text-ink">{customer.name}</span>
                {customer.phone && (
                  <span className="tabular block text-meta text-ink-soft">{customer.phone}</span>
                )}
              </span>
              {customer.balance !== 0 && (
                <span
                  className={`tabular shrink-0 text-meta ${
                    customer.balance > 0 ? 'text-due' : 'text-board'
                  }`}
                >
                  {customer.balance > 0
                    ? `owes ${formatPKR(customer.balance)}`
                    : `advance ${formatPKR(-customer.balance)}`}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
