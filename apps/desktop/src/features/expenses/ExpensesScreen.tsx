import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatPKR, parseMoneyInput, presetRange, today } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { EmptyState, PageHeader, Select, Toolbar } from '@/components/PageHeader';
import { ApiError, api, type Expense } from '@/lib/api';

type Preset = 'today' | 'last7' | 'last30' | 'thisMonth';

const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
};

/**
 * Shop expenses.
 *
 * Small amounts, entered quickly, several times a day. The form stays open after
 * saving so three things in a row is three entries, not three trips.
 */
export function ExpensesScreen(): React.JSX.Element {
  const [preset, setPreset] = useState<Preset>('last30');
  const [editing, setEditing] = useState<Expense | null | 'new'>(null);
  const range = useMemo(() => presetRange(preset), [preset]);

  const expenses = useQuery({
    queryKey: ['expenses', preset],
    queryFn: () => api.expenses({ from: range.from, to: range.to, limit: 400 }),
  });

  const rows = expenses.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.category, (map.get(row.category) ?? 0) + row.amount);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Expenses"
        subtitle={
          expenses.data
            ? `${formatPKR(total)} over ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`
            : undefined
        }
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            Record an expense
          </Button>
        }
      />

      <Toolbar>
        <Select value={preset} onChange={(value) => setPreset(value as Preset)} label="Date range">
          {(Object.keys(PRESET_LABELS) as Preset[]).map((key) => (
            <option key={key} value={key}>
              {PRESET_LABELS[key]}
            </option>
          ))}
        </Select>
        {byCategory.length > 0 && (
          <span className="ml-auto flex flex-wrap gap-x-5 text-meta text-ink-soft">
            {byCategory.slice(0, 4).map(([category, amount]) => (
              <span key={category}>
                {category} <span className="tabular text-ink">{formatPKR(amount)}</span>
              </span>
            ))}
          </span>
        )}
      </Toolbar>

      {expenses.isPending && <p className="px-6 py-8 text-ink-soft">Loading…</p>}

      {expenses.data && rows.length === 0 && (
        <EmptyState
          title="Nothing recorded in this period"
          detail="Rent, electricity, transport, tea — anything the shop spends. Recording them is what turns margin into real profit in your reports."
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              Record an expense
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-rule-strong">
                <th scope="col" className="font-condensed w-36 py-2 pl-6 text-left text-meta font-medium text-ink-soft">
                  Date
                </th>
                <th scope="col" className="font-condensed w-48 py-2 pr-4 text-left text-meta font-medium text-ink-soft">
                  What for
                </th>
                <th scope="col" className="font-condensed py-2 pr-4 text-left text-meta font-medium text-ink-soft">
                  Note
                </th>
                <th scope="col" className="font-condensed w-32 py-2 pr-4 text-left text-meta font-medium text-ink-soft">
                  Recorded by
                </th>
                <th
                  scope="col"
                  className="font-condensed w-32 border-l border-rule-strong py-2 pl-4 pr-6 text-right text-meta font-medium text-ink-soft"
                >
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setEditing(row)}
                  className="cursor-pointer border-b border-rule hover:bg-surface"
                >
                  <td className="py-2.5 pl-6 pr-4 text-meta text-ink-soft">{formatDate(row.spentAt)}</td>
                  <td className="py-2.5 pr-4 text-row text-ink">{row.category}</td>
                  <td className="py-2.5 pr-4 text-meta text-ink-soft">{row.description ?? '—'}</td>
                  <td className="py-2.5 pr-4 text-meta text-ink-soft">{row.userName}</td>
                  <td className="tabular border-l border-rule-strong py-2.5 pl-4 pr-6 text-right text-row font-medium text-ink">
                    {formatPKR(row.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ExpenseDialog
        open={editing !== null}
        expense={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function ExpenseDialog({
  open,
  expense,
  onClose,
}: {
  open: boolean;
  expense: Expense | null;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(expense?.category ?? '');
  const [amount, setAmount] = useState(expense ? String(expense.amount / 100) : '');
  const [description, setDescription] = useState(expense?.description ?? '');
  const [spentAt, setSpentAt] = useState(expense?.spentAt ?? today());
  const [saved, setSaved] = useState<string | null>(null);

  const categories = useQuery({
    queryKey: ['expenseCategories'],
    queryFn: api.expenseCategories,
    enabled: open,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['expenses'] });
    void queryClient.invalidateQueries({ queryKey: ['report'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.saveExpense({
        ...(expense ? { id: expense.id } : {}),
        category: category.trim(),
        description: description.trim() || null,
        amount: parseMoneyInput(amount) ?? 0,
        spentAt,
      }),
    onSuccess: (result) => {
      invalidate();
      if (expense) {
        onClose();
        return;
      }
      // Keep going: expenses come in runs, not one at a time.
      setSaved(`${result.category} — ${formatPKR(result.amount)} saved`);
      setAmount('');
      setDescription('');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.removeExpense(expense!.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const parsed = parseMoneyInput(amount);
  const ready = category.trim().length >= 2 && parsed !== null && parsed > 0;
  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={expense ? 'Edit expense' : 'Record an expense'}
      width="sm"
      footer={
        <>
          {expense && (
            <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete
            </Button>
          )}
          <Button onClick={onClose} disabled={save.isPending}>
            {expense ? 'Cancel' : 'Done'}
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!ready || save.isPending}>
            {save.isPending ? 'Saving…' : expense ? 'Save changes' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="expense-category" className="mb-1.5 block text-meta font-medium text-ink-soft">
            What for
          </label>
          <input
            id="expense-category"
            data-autofocus
            list="expense-categories"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            maxLength={60}
            className="h-10 w-full rounded border border-rule-strong bg-surface px-3 text-row text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
          />
          <datalist id="expense-categories">
            {categories.data?.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </div>

        <Field
          label="Amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="0"
        />

        <Field
          label="Date"
          type="date"
          value={spentAt}
          onChange={(event) => setSpentAt(event.target.value)}
        />

        <Field
          label="Note"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Optional"
          maxLength={200}
        />

        {saved && !error && (
          <p className="rounded border border-board/30 bg-board-tint px-3 py-2.5 text-meta text-board">
            {saved}. Record another, or press Done.
          </p>
        )}

        {error && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
