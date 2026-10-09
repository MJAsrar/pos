import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UNITS, UNIT_LABELS, formatPKR, parseMoneyInput, parseQtyInput, type Unit } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { ApiError, api, type Item } from '@/lib/api';
import { useQueryClient as useClient } from '@tanstack/react-query';

interface ItemEditorDialogProps {
  open: boolean;
  /** Null when adding a new item. */
  item: Item | null;
  canSeeCost: boolean;
  onClose: () => void;
  onSaved: (item: Item) => void;
}

interface FormState {
  code: string;
  name: string;
  categoryId: string;
  unit: Unit;
  cost: string;
  price: string;
  minPrice: string;
  lowStock: string;
  openingQty: string;
  isActive: boolean;
}

const BLANK: FormState = {
  code: '',
  name: '',
  categoryId: '',
  unit: 'pcs',
  cost: '',
  price: '',
  minPrice: '',
  lowStock: '',
  openingQty: '',
  isActive: true,
};

/**
 * The item's picture.
 *
 * Only offered once the item exists, because a picture has to be stored
 * against something. The picture is shrunk on the way in, so a phone photo
 * does not become a four-megabyte row in every backup.
 */
function PhotoField({ item }: { item: Item }): React.JSX.Element {
  const client = useClient();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    if (!item.photoPath) {
      setDataUrl(null);
      setLoaded(true);
      return () => { live = false; };
    }
    void api.itemPhoto(item.id).then((r) => { if (live) { setDataUrl(r.dataUrl); setLoaded(true); } });
    return () => { live = false; };
  }, [item.id, item.photoPath]);

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['items'] });
    void client.invalidateQueries({ queryKey: ['itemPhoto', item.id] });
  };

  const choose = useMutation({
    mutationFn: () => api.setItemPhoto(item.id),
    onSuccess: (result) => {
      if (!result.cancelled) {
        setDataUrl(result.dataUrl ?? null);
        refresh();
      }
    },
  });

  const clear = useMutation({
    mutationFn: () => api.clearItemPhoto(item.id),
    onSuccess: () => { setDataUrl(null); refresh(); },
  });

  const error = choose.error instanceof ApiError ? choose.error.message : undefined;

  return (
    <div className="border-t border-rule pt-4">
      <span className="mb-2 block text-meta font-medium text-ink-soft">Picture</span>
      <div className="flex items-center gap-4">
        <span className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded border border-rule-strong bg-sunk">
          {dataUrl ? (
            <img src={dataUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-micro text-ink-faint">{loaded ? 'none' : ''}</span>
          )}
        </span>
        <div className="flex gap-2">
          <Button onClick={() => choose.mutate()} disabled={choose.isPending}>
            {choose.isPending ? 'Opening…' : dataUrl ? 'Change picture' : 'Choose a picture'}
          </Button>
          {dataUrl && (
            <Button variant="quiet" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-meta text-due">{error}</p>}
      <p className="mt-2 text-meta text-ink-faint">
        Shown on the Browse items screen, which is how staff find things without the code.
      </p>
    </div>
  );
}

/**
 * Add or edit an item.
 *
 * Quantity is absent when editing on purpose: stock only ever moves by recording
 * a stock-in or an adjustment, so that every quantity has an explanation behind
 * it. The one exception is a brand new item, where the opening count is the
 * first movement in its history.
 */
export function ItemEditorDialog({
  open,
  item,
  canSeeCost,
  onClose,
  onSaved,
}: ItemEditorDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(BLANK);
  const isNew = item === null;

  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories, enabled: open });
  const suggested = useQuery({
    queryKey: ['item', 'nextCode'],
    queryFn: api.nextItemCode,
    enabled: open && isNew,
  });

  useEffect(() => {
    if (!open) return;
    setForm(
      item
        ? {
            code: item.code,
            name: item.name,
            categoryId: item.categoryId ?? '',
            unit: item.unit,
            cost: item.costPrice === null ? '' : String(item.costPrice / 100),
            price: String(item.salePrice / 100),
            minPrice: item.minPrice === null ? '' : String(item.minPrice / 100),
            lowStock: item.lowStockLevel ? String(item.lowStockLevel) : '',
            openingQty: '',
            isActive: item.isActive,
          }
        : BLANK,
    );
  }, [open, item]);

  useEffect(() => {
    if (open && isNew && suggested.data && !form.code) {
      setForm((current) => ({ ...current, code: suggested.data.code }));
    }
  }, [open, isNew, suggested.data, form.code]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        categoryId: form.categoryId || null,
        unit: form.unit,
        costPrice: parseMoneyInput(form.cost) ?? 0,
        salePrice: parseMoneyInput(form.price) ?? 0,
        minPrice: form.minPrice.trim() ? parseMoneyInput(form.minPrice) : null,
        lowStockLevel: parseQtyInput(form.lowStock) ?? 0,
        photoPath: null,
      };
      return item
        ? api.saveItem({ ...payload, id: item.id, isActive: form.isActive })
        : api.createItem({ ...payload, openingQty: parseQtyInput(form.openingQty) ?? 0 });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      onSaved(saved);
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const price = parseMoneyInput(form.price);
  const cost = parseMoneyInput(form.cost);
  const margin = price !== null && cost !== null && cost > 0 ? price - cost : null;

  const ready = form.code.trim().length > 0 && form.name.trim().length >= 2 && price !== null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Add an item' : form.name || 'Edit item'}
      {...(isNew ? {} : { description: 'To change the quantity, use Stock in or Adjust stock.' })}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!ready || save.isPending}>
            {save.isPending ? 'Saving…' : isNew ? 'Add item' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[8rem_1fr] gap-4">
          <Field
            label="Code"
            data-autofocus
            value={form.code}
            onChange={(event) => set('code', event.target.value.toUpperCase())}
            hint={isNew ? 'Staff will type this' : undefined}
            error={error?.fields['code']}
            maxLength={24}
          />
          <Field
            label="Name"
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            error={error?.fields['name']}
            maxLength={120}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="category" className="mb-1.5 block text-meta font-medium text-ink-soft">
              Category
            </label>
            <select
              id="category"
              value={form.categoryId}
              onChange={(event) => set('categoryId', event.target.value)}
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
            <label htmlFor="unit" className="mb-1.5 block text-meta font-medium text-ink-soft">
              Sold by
            </label>
            <select
              id="unit"
              value={form.unit}
              onChange={(event) => set('unit', event.target.value as Unit)}
              className="h-10 w-full rounded border border-rule-strong bg-surface px-3 text-row text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
            >
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {UNIT_LABELS[unit]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 border-t border-rule pt-4">
          {canSeeCost && (
            <Field
              label="Cost price"
              value={form.cost}
              onChange={(event) => set('cost', event.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          )}
          <Field
            label="Sale price"
            value={form.price}
            onChange={(event) => set('price', event.target.value)}
            inputMode="decimal"
            placeholder="0"
            error={error?.fields['salePrice']}
          />
          <Field
            label="Lowest price"
            value={form.minPrice}
            onChange={(event) => set('minPrice', event.target.value)}
            inputMode="decimal"
            placeholder="none"
            hint="Bargaining floor"
          />
        </div>

        {margin !== null && (
          <p className="text-meta text-ink-soft">
            Margin {formatPKR(margin)} per {form.unit}
            {cost && cost > 0 ? ` (${Math.round((margin / cost) * 100)}%)` : ''}
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 border-t border-rule pt-4">
          <Field
            label="Tell me when stock falls to"
            value={form.lowStock}
            onChange={(event) => set('lowStock', event.target.value)}
            inputMode="decimal"
            placeholder="0"
            hint="Leave blank for no warning"
          />
          {isNew && (
            <Field
              label="How many in stock now"
              value={form.openingQty}
              onChange={(event) => set('openingQty', event.target.value)}
              inputMode="decimal"
              placeholder="0"
              hint="Recorded as opening stock"
            />
          )}
        </div>

        {!isNew && item && <PhotoField item={item} />}

        {!isNew && (
          <label className="flex items-center gap-2.5 border-t border-rule pt-4 text-base text-ink">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => set('isActive', event.target.checked)}
              className="size-4 accent-board"
            />
            Still selling this item
          </label>
        )}

        {error && !Object.keys(error.fields).length && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
