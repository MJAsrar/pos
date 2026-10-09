import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPKR, parseMoneyInput } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { EmptyState, PageHeader, SearchInput, Toolbar } from '@/components/PageHeader';
import { ApiError, api, type Customer } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CustomerLedgerDialog } from './CustomerLedgerDialog';

/**
 * The customer list, sorted by what is owed.
 *
 * Whoever owes the most is at the top, because that is the list the owner
 * actually works from when chasing payments.
 */
export function CustomersScreen(): React.JSX.Element {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [duesOnly, setDuesOnly] = useState(false);
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Customer | null | 'new'>(null);

  const customers = useQuery({ queryKey: ['customers'], queryFn: () => api.customers() });
  const summary = useQuery({ queryKey: ['duesSummary'], queryFn: api.duesSummary });

  const rows = useMemo(() => {
    let list = customers.data ?? [];
    if (duesOnly) list = list.filter((customer) => customer.balance > 0);
    const needle = search.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (customer) =>
          customer.name.toLowerCase().includes(needle) || (customer.phone ?? '').includes(needle),
      );
    }
    return list;
  }, [customers.data, duesOnly, search]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Customers"
        subtitle={
          summary.data
            ? summary.data.customersOwing === 0
              ? 'Nobody owes anything'
              : `${summary.data.customersOwing} ${summary.data.customersOwing === 1 ? 'customer owes' : 'customers owe'} ${formatPKR(summary.data.owedToShop)}`
            : undefined
        }
        actions={
          can('customer.manage') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              Add customer
            </Button>
          ) : undefined
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or phone" autoFocus />
        <label className="flex items-center gap-2 text-meta text-ink-soft">
          <input
            type="checkbox"
            checked={duesOnly}
            onChange={(event) => setDuesOnly(event.target.checked)}
            className="size-3.5 accent-board"
          />
          Only those who owe money
        </label>
      </Toolbar>

      {customers.isPending && <p className="px-6 py-8 text-ink-soft">Loading…</p>}

      {customers.data && rows.length === 0 && (
        <EmptyState
          title={search.trim() ? `Nothing matches “${search}”` : duesOnly ? 'Nobody owes anything' : 'No customers yet'}
          detail={
            duesOnly
              ? 'Every account is clear.'
              : 'Add a customer to start selling on udhaar, with their balance carried over from the register.'
          }
        />
      )}

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-rule-strong">
                <th scope="col" className="font-condensed py-2 pl-6 text-left text-meta font-medium text-ink-soft">
                  Name
                </th>
                <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
                  Phone
                </th>
                <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
                  Address
                </th>
                <th
                  scope="col"
                  className="font-condensed w-36 py-2 pr-6 text-right text-meta font-medium text-ink-soft"
                >
                  Balance
                </th>
                <th scope="col" className="w-40 pr-6" />
              </tr>
            </thead>
            <tbody>
              {rows.map((customer) => (
                <tr
                  key={customer.id}
                  className="group cursor-pointer border-b border-rule hover:bg-surface"
                  onClick={() => setLedgerFor(customer.id)}
                >
                  <td className="py-2.5 pl-6 pr-4">
                    <span className="text-row text-ink">{customer.name}</span>
                    {!customer.isActive && (
                      <span className="ml-2 rounded bg-sunk px-1.5 py-0.5 text-micro text-ink-soft">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="tabular py-2.5 pr-4 text-meta text-ink-soft">{customer.phone ?? '—'}</td>
                  <td className="py-2.5 pr-4 text-meta text-ink-soft">{customer.address ?? '—'}</td>
                  <td className="py-2.5 pr-6 text-right">
                    {customer.balance === 0 ? (
                      <span className="text-meta text-ink-faint">clear</span>
                    ) : (
                      <span
                        className={`tabular text-row font-medium ${
                          customer.balance > 0 ? 'text-due' : 'text-board'
                        }`}
                      >
                        {formatPKR(Math.abs(customer.balance))}
                        {customer.balance < 0 && (
                          <span className="block text-micro font-normal text-ink-soft">in advance</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-6 text-right">
                    <span className="flex justify-end gap-1 opacity-55 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setLedgerFor(customer.id);
                        }}
                        className="rounded px-2 py-1 text-meta text-ink-soft hover:bg-sunk hover:text-ink"
                      >
                        Khata
                      </button>
                      {can('customer.manage') && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditing(customer);
                          }}
                          className="rounded px-2 py-1 text-meta text-ink-soft hover:bg-sunk hover:text-ink"
                        >
                          Edit
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CustomerLedgerDialog
        open={ledgerFor !== null}
        customerId={ledgerFor}
        onClose={() => setLedgerFor(null)}
      />

      <CustomerEditorDialog
        open={editing !== null}
        customer={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function CustomerEditorDialog({
  open,
  customer,
  onClose,
}: {
  open: boolean;
  customer: Customer | null;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [opening, setOpening] = useState('');

  const isNew = customer === null;

  useEffect(() => {
    if (!open) return;
    setName(customer?.name ?? '');
    setPhone(customer?.phone ?? '');
    setAddress(customer?.address ?? '');
    setNotes(customer?.notes ?? '');
    setOpening('');
  }, [open, customer]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        phone: phone.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
      };
      return customer
        ? api.saveCustomer({ ...payload, id: customer.id })
        : api.createCustomer({ ...payload, openingBalance: parseMoneyInput(opening) ?? 0 });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['duesSummary'] });
      onClose();
    },
  });

  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Add a customer' : 'Edit customer'}
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={name.trim().length < 2 || save.isPending}
          >
            {save.isPending ? 'Saving…' : isNew ? 'Add customer' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Name"
          data-autofocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
        />
        <Field
          label="Phone number"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          inputMode="tel"
          placeholder="0300 1234567"
          maxLength={40}
        />
        <Field
          label="Address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={160}
        />

        {isNew && (
          <Field
            label="Already owes from the register"
            value={opening}
            onChange={(event) => setOpening(event.target.value)}
            inputMode="decimal"
            placeholder="0"
            hint="Their current balance from the paper khata. Leave blank if they owe nothing."
          />
        )}

        <Field
          label="Notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={400}
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
