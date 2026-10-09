import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UNITS, UNIT_LABELS, formatPKR, parseMoneyInput, parseQtyInput, type Unit } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Item } from '@/lib/api';

/**
 * Add an item without leaving the sale.
 *
 * The shop is starting with a partial catalogue, so a customer asking for
 * something that is not in the system yet is an everyday event, not an edge
 * case. Abandoning a half-made bill to go and set the item up properly is how a
 * queue forms — and how staff learn to stop recording things.
 *
 * So this asks for the least that makes a sale honest: what it is, what it
 * sells for, and how many are on the shelf. Everything else can be filled in on
 * the Items screen later, when nobody is waiting.
 */
export function NewItemDialog({
  open,
  initialName,
  canSeeCost,
  onCreated,
  onClose,
}: {
  open: boolean;
  /** Whatever was typed in the search box, so nothing is retyped. */
  initialName: string;
  canSeeCost: boolean;
  onCreated: (item: Item) => void;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<Unit>('pcs');
  const [categoryId, setCategoryId] = useState('');
  const [code, setCode] = useState('');

  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories, enabled: open });
  const suggested = useQuery({ queryKey: ['item', 'nextCode'], queryFn: api.nextItemCode, enabled: open });

  useEffect(() => {
    if (!open) return;
    setName(initialName.trim());
    setPrice('');
    setCost('');
    setQty('');
    setUnit('pcs');
    setCategoryId('');
    setCode('');
  }, [open, initialName]);

  useEffect(() => {
    if (open && suggested.data && !code) setCode(suggested.data.code);
  }, [open, suggested.data, code]);

  const create = useMutation({
    mutationFn: () =>
      api.createItem({
        code: code.trim(),
        name: name.trim(),
        categoryId: categoryId || null,
        unit,
        costPrice: parseMoneyInput(cost) ?? 0,
        salePrice: parseMoneyInput(price) ?? 0,
        minPrice: null,
        lowStockLevel: 0,
        photoPath: null,
        openingQty: parseQtyInput(qty) ?? 0,
      }),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      onCreated(item);
    },
  });

  const error = create.error instanceof ApiError ? create.error : null;
  const parsedPrice = parseMoneyInput(price);
  const ready = name.trim().length >= 2 && parsedPrice !== null && parsedPrice > 0 && code.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add this item"
      description="Just enough to sell it now. The rest can wait until the counter is quiet."
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => create.mutate()}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? 'Saving…' : 'Add and put on the bill'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) create.mutate();
        }}
      >
        <Field
          label="What is it"
          data-autofocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          error={error?.fields['name']}
        />

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Sells for"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            inputMode="decimal"
            placeholder="0"
          />
          {canSeeCost ? (
            <Field
              label="Cost"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              hint="Leave blank if unsure"
            />
          ) : (
            <Field
              label="How many you have"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          )}
        </div>

        {canSeeCost && (
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="How many you have"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              hint="Counted as opening stock"
            />
            <Field
              label="Code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={24}
              error={error?.fields['code']}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="quick-category" className="mb-1.5 block text-meta font-medium text-ink-soft">
              Category
            </label>
            <select
              id="quick-category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="h-10 w-full rounded border border-rule-strong bg-surface px-3 text-row text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
            >
              <option value="">No category</option>
              {categories.data?.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="quick-unit" className="mb-1.5 block text-meta font-medium text-ink-soft">
              Sold by
            </label>
            <select
              id="quick-unit"
              value={unit}
              onChange={(event) => setUnit(event.target.value as Unit)}
              className="h-10 w-full rounded border border-rule-strong bg-surface px-3 text-row text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
            >
              {UNITS.map((value) => (
                <option key={value} value={value}>
                  {UNIT_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!canSeeCost && (
          <Field
            label="Code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            maxLength={24}
            error={error?.fields['code']}
          />
        )}

        {parsedPrice !== null && parsedPrice > 0 && (
          <p className="text-meta text-ink-soft">
            Goes on the bill at {formatPKR(parsedPrice)}.
          </p>
        )}

        {error && Object.keys(error.fields).length === 0 && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {error.message}
          </p>
        )}
      </form>
    </Modal>
  );
}
