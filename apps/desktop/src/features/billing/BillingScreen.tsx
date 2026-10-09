import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  allowsFractionalQty,
  formatDateTime,
  formatPKR,
  formatQty,
  formatTime,
  parseMoneyInput,
  parseQtyInput,
  type PaymentMethod,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { NumberPrompt } from '@/components/NumberPrompt';
import { ApiError, api, type Customer, type Sale } from '@/lib/api';
import { findByExactCode, parseQuantityPrefix, searchItems } from '@/lib/search';
import { useSession } from '@/lib/session';
import { CategoryBrowser } from './CategoryBrowser';
import { CustomerPickerDialog } from './CustomerPickerDialog';
import { HeldBillsDialog, parseHeld } from './HeldBillsDialog';
import { ItemSearchDialog } from './ItemSearchDialog';
import { NewItemDialog } from './NewItemDialog';
import { PaymentDialog } from './PaymentDialog';
import { useCart, type CartLine } from './useCart';

type Dialog =
  | 'none'
  | 'search'
  | 'newItem'
  | 'customer'
  | 'qty'
  | 'price'
  | 'discount'
  | 'payment'
  | 'held';

/** What the middle of the screen is showing. */
type Centre = 'bill' | 'browse';

/**
 * The counter screen.
 *
 * Everything here is arranged around one idea: a whole sale should be possible
 * without the mouse, and the cursor should be back in the search box after every
 * single action. The layout borrows from the paper khata it replaces — ruled
 * rows, no cards, and a hard vertical rule before the money column.
 */
export function BillingScreen(): React.JSX.Element {
  const { user, can } = useSession();
  const queryClient = useQueryClient();
  const cart = useCart();

  const [entry, setEntry] = useState('');
  const [dialog, setDialog] = useState<Dialog>('none');
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<{ sale: Sale; change: number } | null>(null);
  // Opens on the shelves rather than an empty page, because between customers
  // that is the more useful thing for the screen to be showing.
  const [centre, setCentre] = useState<Centre>('browse');
  const [browseCategoryId, setBrowseCategoryId] = useState<string | null>(null);
  /** What the quick-add form should start with, carried from the search box. */
  const [newItemName, setNewItemName] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const items = useQuery({ queryKey: ['items'], queryFn: () => api.items() });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const catalogue = useMemo(() => items.data ?? [], [items.data]);

  const focusSearch = useCallback(() => {
    // Let whatever just closed finish unmounting before taking focus back.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const closeDialog = useCallback(() => {
    setDialog('none');
    focusSearch();
  }, [focusSearch]);

  const save = useMutation({
    mutationFn: (payment: { paymentMethod: PaymentMethod; tendered: number }) =>
      api.createSale({
        lines: cart.lines.map((line) => ({
          itemId: line.item.id,
          qty: line.qty,
          unitPrice: line.unitPrice,
        })),
        customerId: cart.customer?.id ?? null,
        discount: cart.discount,
        paymentMethod: payment.paymentMethod,
        tendered: payment.tendered,
      }),
    onSuccess: (result) => {
      setLastSale({ sale: result.sale, change: result.change });
      cart.clear();
      setEntry('');
      setDialog('none');
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      setCentre('browse');
      focusSearch();
    },
  });

  const saveError = save.error instanceof ApiError ? save.error.message : undefined;

  /** Set the current bill aside so the queue can be served. */
  const park = useMutation({
    mutationFn: () =>
      api.holdSale(
        cart.customer?.name ?? `${cart.lines.length} items`,
        JSON.stringify({
          lines: cart.lines.map((line) => ({
            itemId: line.item.id,
            qty: line.qty,
            unitPrice: line.unitPrice,
            priceEdited: line.priceEdited,
          })),
          discount: cart.discount,
          customerId: cart.customer?.id ?? null,
          customerName: cart.customer?.name ?? null,
          total: cart.totals.total,
          itemCount: cart.lines.length,
        }),
      ),
    onSuccess: () => {
      cart.clear();
      setEntry('');
      setNotice('Bill parked. Press F8 to bring it back.');
      void queryClient.invalidateQueries({ queryKey: ['heldSales'] });
      focusSearch();
    },
  });

  /** Add whatever is in the search box, or open the search list if unsure. */
  const commitEntry = useCallback(() => {
    const raw = entry.trim();
    if (!raw) return;

    const { qty, term } = parseQuantityPrefix(raw, catalogue);
    const exact = findByExactCode(catalogue, term);

    if (exact) {
      cart.addItem(exact, qty);
      setEntry('');
      setNotice(null);
      setCentre('bill');
      return;
    }

    const matches = searchItems(catalogue, term, 2);
    if (matches.length === 1 && matches[0]) {
      cart.addItem(matches[0].item, qty);
      setEntry('');
      setNotice(null);
      setCentre('bill');
      return;
    }

    // Ambiguous or unknown: show the list rather than guessing at the counter.
    setDialog('search');
  }, [entry, catalogue, cart]);

  // Screen-level shortcuts. Dialogs listen in the capture phase, so they win.
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (dialog !== 'none') return;
      const typing = event.target instanceof HTMLInputElement;

      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        if (!cart.isEmpty) {
          save.mutate({ paymentMethod: 'cash', tendered: cart.totals.total });
        }
        return;
      }

      switch (event.key) {
        case 'F2':
          event.preventDefault();
          setDialog('customer');
          return;
        case 'F3':
          event.preventDefault();
          setDialog('search');
          return;
        case 'F5':
          event.preventDefault();
          if (cart.selected) setDialog('qty');
          return;
        case 'F6':
          event.preventDefault();
          if (!cart.isEmpty) setDialog('discount');
          return;
        case 'F7':
          event.preventDefault();
          if (!cart.isEmpty && !park.isPending) park.mutate();
          return;
        case 'F8':
          event.preventDefault();
          setDialog('held');
          return;
        case 'F4':
          event.preventDefault();
          setCentre((current) => (current === 'browse' ? 'bill' : 'browse'));
          return;
        case 'F9':
          event.preventDefault();
          if (cart.selected && can('sale.edit_price')) setDialog('price');
          return;
        case 'F12':
          event.preventDefault();
          if (!cart.isEmpty) setDialog('payment');
          return;
        case 'ArrowUp':
          if (typing) return;
          event.preventDefault();
          cart.moveSelection(-1);
          return;
        case 'ArrowDown':
          if (typing) return;
          event.preventDefault();
          cart.moveSelection(1);
          return;
        case 'Delete':
          if (typing && (event.target as HTMLInputElement).value !== '') return;
          event.preventDefault();
          if (cart.selectedKey) cart.removeLine(cart.selectedKey);
          return;
        case 'Escape':
          event.preventDefault();
          if (entry) {
            setEntry('');
          } else if (!cart.isEmpty) {
            setNotice('Press Escape again to clear this bill.');
            if (notice) {
              cart.clear();
              setNotice(null);
            }
          }
          focusSearch();
          return;
        default:
          break;
      }

      // +/- adjust the selected line, but only when not mid-word in the box.
      if ((event.key === '+' || event.key === '-') && !typing && cart.selectedKey) {
        event.preventDefault();
        cart.bumpQty(cart.selectedKey, event.key === '+' ? 1 : -1);
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [dialog, cart, entry, notice, can, save, park, focusSearch]);

  useEffect(focusSearch, [focusSearch]);

  const enforceMinPrice = settings.data?.enforceMinPrice ?? true;
  const belowFloor = cart.lines.filter(
    (line) => line.item.minPrice !== null && line.unitPrice < line.item.minPrice,
  );

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <Header
          customer={cart.customer}
          cashier={user.fullName}
          onChangeCustomer={() => setDialog('customer')}
          onClearCustomer={() => cart.setCustomer(null)}
        />

        <div className="border-b border-rule bg-surface px-6 py-3">
          <input
            ref={searchRef}
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitEntry();
              }
            }}
            placeholder="Type a code or name, then press Enter"
            aria-label="Add an item to the bill"
            className="h-12 w-full rounded border border-rule-strong bg-paper px-4 text-section text-ink placeholder:text-ink-faint focus:border-board focus:bg-surface focus:outline-none focus:ring-2 focus:ring-board/20"
          />
        </div>

        <CentreToggle
          centre={centre}
          lineCount={cart.lines.length}
          onChange={setCentre}
        />

        {centre === 'browse' ? (
          <CategoryBrowser
            categories={categories.data ?? []}
            items={catalogue}
            openCategoryId={browseCategoryId}
            onOpenCategory={setBrowseCategoryId}
            onPick={(item) => cart.addItem(item, 1)}
          />
        ) : (
          <LedgerTable cart={cart} onEditQty={() => setDialog('qty')} />
        )}

        {notice && (
          <p className="border-t border-brass/40 bg-brass-tint px-6 py-2 text-meta text-ink">
            {notice}
          </p>
        )}

        <KeyBar canEditPrice={can('sale.edit_price')} />
      </section>

      <TotalsPanel
        cart={cart}
        lastSale={lastSale}
        belowFloorCount={belowFloor.length}
        enforceMinPrice={enforceMinPrice}
        onPay={() => setDialog('payment')}
        onDiscount={() => setDialog('discount')}
      />

      <ItemSearchDialog
        open={dialog === 'search'}
        items={catalogue}
        initialQuery={parseQuantityPrefix(entry, catalogue).term}
        canAddItem={can('item.manage')}
        onCreate={(name) => {
          setNewItemName(name);
          setDialog('newItem');
        }}
        onPick={(item) => {
          cart.addItem(item, parseQuantityPrefix(entry, catalogue).qty);
          setEntry('');
          setCentre('bill');
          closeDialog();
        }}
        onClose={closeDialog}
      />

      <NewItemDialog
        open={dialog === 'newItem'}
        initialName={newItemName}
        canSeeCost={can('item.view_cost')}
        onCreated={(item) => {
          // Straight onto the bill, at the quantity that was typed.
          cart.addItem(item, parseQuantityPrefix(entry, catalogue).qty);
          setEntry('');
          setCentre('bill');
          closeDialog();
        }}
        onClose={() => {
          // Back to the search list, not the bill — the item was not added.
          setDialog('search');
        }}
      />

      <CustomerPickerDialog
        open={dialog === 'customer'}
        canAddCustomer={can('customer.manage')}
        onPick={(customer) => {
          cart.setCustomer(customer);
          closeDialog();
        }}
        onClose={closeDialog}
      />

      <NumberPrompt
        open={dialog === 'qty'}
        title="Change quantity"
        label={cart.selected ? `${cart.selected.item.name} (${cart.selected.item.unit})` : 'Quantity'}
        initialValue={cart.selected ? formatQty(cart.selected.qty) : '1'}
        validate={(raw) => {
          const parsed = parseQtyInput(raw);
          if (parsed === null) return 'Enter a quantity greater than zero.';
          if (cart.selected && !allowsFractionalQty(cart.selected.item.unit) && !Number.isInteger(parsed)) {
            return `${cart.selected.item.name} is sold in whole ${cart.selected.item.unit}.`;
          }
          return null;
        }}
        hint={(raw) => {
          const parsed = parseQtyInput(raw);
          if (parsed === null || !cart.selected) return null;
          return `Line total ${formatPKR(Math.round(parsed * cart.selected.unitPrice))}`;
        }}
        onConfirm={(raw) => {
          const parsed = parseQtyInput(raw);
          if (parsed !== null && cart.selectedKey) cart.setQty(cart.selectedKey, parsed);
          closeDialog();
        }}
        onClose={closeDialog}
      />

      <NumberPrompt
        open={dialog === 'price'}
        title="Change rate"
        description="Every change of rate is recorded against your name."
        label={cart.selected ? `Rate for ${cart.selected.item.name}` : 'Rate'}
        initialValue={cart.selected ? String(Math.round(cart.selected.unitPrice / 100)) : '0'}
        validate={(raw) => {
          const parsed = parseMoneyInput(raw);
          if (parsed === null || parsed < 0) return 'Enter a rate in rupees.';
          const floor = cart.selected?.item.minPrice ?? null;
          if (floor !== null && parsed < floor && enforceMinPrice) {
            return `The lowest allowed rate for this item is ${formatPKR(floor)}.`;
          }
          return null;
        }}
        hint={(raw) => {
          const parsed = parseMoneyInput(raw);
          if (parsed === null || !cart.selected) return null;
          const listed = cart.selected.item.salePrice;
          const difference = parsed - listed;
          return difference === 0
            ? `Listed rate ${formatPKR(listed)}`
            : `${formatPKR(Math.abs(difference))} ${difference < 0 ? 'below' : 'above'} the listed ${formatPKR(listed)}`;
        }}
        onConfirm={(raw) => {
          const parsed = parseMoneyInput(raw);
          if (parsed !== null && cart.selectedKey) cart.setPrice(cart.selectedKey, parsed);
          closeDialog();
        }}
        onClose={closeDialog}
      />

      <NumberPrompt
        open={dialog === 'discount'}
        title="Discount on this bill"
        label="Discount in rupees"
        initialValue={String(Math.round(cart.discount / 100))}
        validate={(raw) => {
          const parsed = parseMoneyInput(raw);
          if (parsed === null || parsed < 0) return 'Enter an amount in rupees.';
          if (parsed > cart.totals.subtotal) return 'The discount cannot be more than the bill.';
          return null;
        }}
        hint={(raw) => {
          const parsed = parseMoneyInput(raw);
          if (parsed === null) return null;
          return `New total ${formatPKR(Math.max(cart.totals.subtotal - parsed, 0))}`;
        }}
        confirmLabel="Apply discount"
        onConfirm={(raw) => {
          const parsed = parseMoneyInput(raw);
          if (parsed !== null) cart.setDiscount(parsed);
          closeDialog();
        }}
        onClose={closeDialog}
      />

      <HeldBillsDialog
        open={dialog === 'held'}
        onRecall={(entry) => {
          const payload = parseHeld(entry);
          closeDialog();
          if (!payload) {
            setNotice('That parked bill could not be read, so it was discarded.');
            return;
          }
          // Prices are re-read from the catalogue; only the quantity and any
          // bargained rate come from the draft.
          cart.clear();
          for (const line of payload.lines) {
            const item = catalogue.find((candidate) => candidate.id === line.itemId);
            if (item) cart.addItem(item, line.qty);
          }
          cart.setDiscount(payload.discount);
          setNotice(`Brought back: ${entry.label}`);
        }}
        onClose={closeDialog}
      />

      <PaymentDialog
        open={dialog === 'payment'}
        total={cart.totals.total}
        customer={cart.customer}
        canSellOnCredit={can('sale.credit')}
        busy={save.isPending}
        error={saveError}
        onConfirm={(payment) => save.mutate(payment)}
        onClose={() => {
          save.reset();
          closeDialog();
        }}
        onNeedCustomer={() => setDialog('customer')}
      />
    </div>
  );
}

function Header({
  customer,
  cashier,
  onChangeCustomer,
  onClearCustomer,
}: {
  customer: Customer | null;
  cashier: string;
  onChangeCustomer: () => void;
  onClearCustomer: () => void;
}): React.JSX.Element {
  return (
    <header className="flex items-center justify-between gap-6 border-b border-rule px-6 py-3.5">
      <div>
        <h1 className="text-section font-semibold text-ink">New bill</h1>
        <p className="text-meta text-ink-soft">
          {formatDateTime(new Date())} — {cashier}
        </p>
      </div>

      {customer ? (
        <div className="flex items-center gap-3 rounded border border-rule-strong bg-surface py-1.5 pl-3 pr-1.5">
          <span>
            <span className="block text-base font-medium text-ink">{customer.name}</span>
            {customer.balance > 0 && (
              <span className="tabular block text-meta text-due">
                owes {formatPKR(customer.balance)}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onClearCustomer}
            aria-label={`Remove ${customer.name} from this bill`}
            className="rounded px-2 py-1 text-meta text-ink-soft transition-colors duration-100 hover:bg-sunk hover:text-ink"
          >
            Remove
          </button>
        </div>
      ) : (
        <Button onClick={onChangeCustomer} shortcut="F2">
          Add customer
        </Button>
      )}
    </header>
  );
}

/**
 * Switch the middle of the screen between the bill and the shelves.
 *
 * The line count sits on the tab so that browsing never means losing track of
 * what has already been rung up.
 */
function CentreToggle({
  centre,
  lineCount,
  onChange,
}: {
  centre: Centre;
  lineCount: number;
  onChange: (centre: Centre) => void;
}): React.JSX.Element {
  const tabs: Array<[Centre, string]> = [
    ['bill', lineCount > 0 ? `Bill (${lineCount})` : 'Bill'],
    ['browse', 'Browse items'],
  ];

  return (
    <div className="flex items-center gap-1 border-b border-rule px-6 py-2">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-current={centre === id ? 'true' : undefined}
          className={`rounded px-3 py-1.5 text-base transition-colors duration-100 ${
            centre === id
              ? 'bg-ink font-medium text-white'
              : 'text-ink-soft hover:bg-sunk hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
      <kbd className="font-condensed ml-1 rounded border border-rule-strong px-1 text-micro text-ink-faint">
        F4
      </kbd>
    </div>
  );
}

function LedgerTable({
  cart,
  onEditQty,
}: {
  cart: ReturnType<typeof useCart>;
  onEditQty: () => void;
}): React.JSX.Element {
  if (cart.isEmpty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-section text-ink-soft">Start the bill</p>
        <p className="max-w-sm text-meta text-ink-faint">
          Type an item code and press Enter, or press F3 to search by name.
        </p>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      {/* The ruled money column, drawn down the whole page the way a khata is
          printed — not stopping under the last line written. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-32 w-px bg-rule-strong" />
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10 bg-paper">
          <tr className="border-b border-rule-strong">
            <th scope="col" className="font-condensed w-10 py-2 pl-6 text-left text-meta font-medium text-ink-soft">
              #
            </th>
            <th scope="col" className="font-condensed py-2 text-left text-meta font-medium text-ink-soft">
              Item
            </th>
            <th scope="col" className="font-condensed w-24 py-2 text-right text-meta font-medium text-ink-soft">
              Qty
            </th>
            <th scope="col" className="font-condensed w-28 py-2 text-right text-meta font-medium text-ink-soft">
              Rate
            </th>
            {/* The khata's vertical rule: money lives to the right of this line. */}
            <th
              scope="col"
              className="font-condensed w-32 py-2 pr-6 text-right text-meta font-medium text-ink-soft"
            >
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {cart.lines.map((line, index) => {
            const selected = line.key === cart.selectedKey;
            const short = line.qty > line.item.qtyOnHand;
            return (
              <tr
                key={line.key}
                onClick={() => cart.setSelectedKey(line.key)}
                onDoubleClick={onEditQty}
                className={[
                  'cursor-default border-b border-rule',
                  selected ? 'bg-surface' : '',
                  line.key === cart.landedKey ? 'row-landed' : '',
                ].join(' ')}
              >
                <td className="tabular py-2.5 pl-6 text-meta text-ink-faint">{index + 1}</td>
                <td className="py-2.5 pr-4">
                  <span className="block text-row text-ink">{line.item.name}</span>
                  <span className="tabular block text-meta text-ink-faint">
                    {line.item.code}
                    {short && (
                      <span className="ml-2 text-due">
                        {line.item.qtyOnHand <= 0
                          ? 'none in stock'
                          : `only ${formatQty(line.item.qtyOnHand)} in stock`}
                      </span>
                    )}
                  </span>
                </td>
                <td className="tabular py-2.5 text-right text-row text-ink">
                  {formatQty(line.qty)}
                  <span className="ml-1 text-meta text-ink-faint">{line.item.unit}</span>
                </td>
                <td className="tabular py-2.5 text-right text-row">
                  <span className={line.priceEdited ? 'font-medium text-brass' : 'text-ink'}>
                    {formatPKR(line.unitPrice)}
                  </span>
                </td>
                <td className="tabular py-2.5 pr-6 text-right text-row font-medium text-ink">
                  {formatPKR(Math.round(line.qty * line.unitPrice))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TotalsPanel({
  cart,
  lastSale,
  belowFloorCount,
  enforceMinPrice,
  onPay,
  onDiscount,
}: {
  cart: ReturnType<typeof useCart>;
  lastSale: { sale: Sale; change: number } | null;
  belowFloorCount: number;
  enforceMinPrice: boolean;
  onPay: () => void;
  onDiscount: () => void;
}): React.JSX.Element {
  const { totals, customer } = cart;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-rule bg-surface">
      {cart.isEmpty ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {lastSale && <LastSale lastSale={lastSale} />}
          <RecentBills />
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between border-b border-rule px-5 py-2.5">
            <span className="font-condensed text-meta font-medium text-ink-soft">
              {cart.lines.length} {cart.lines.length === 1 ? 'item' : 'items'}
            </span>
            <span className="tabular text-meta text-ink-soft">{formatPKR(totals.subtotal)}</span>
          </div>

          {/* The running bill. Visible whatever the middle of the screen is
              doing, so tapping through a category never means billing blind. */}
          <ul className="min-h-0 flex-1 divide-y divide-rule overflow-y-auto">
            {cart.lines.map((line) => (
              <CartRow
                key={line.key}
                line={line}
                selected={line.key === cart.selectedKey}
                landed={line.key === cart.landedKey}
                onSelect={() => cart.setSelectedKey(line.key)}
                onRemove={() => cart.removeLine(line.key)}
              />
            ))}
          </ul>
        </>
      )}

      <div className="border-t border-rule px-5 pt-3 pb-4">
        {totals.discount > 0 && (
          <div className="flex items-baseline justify-between text-base">
            <span className="text-ink-soft">Discount</span>
            <span className="tabular text-board">-{formatPKR(totals.discount)}</span>
          </div>
        )}

        {totals.rounding !== 0 && (
          <div className="flex items-baseline justify-between text-base">
            <span className="text-ink-soft">Rounding</span>
            <span className="tabular text-ink-soft">
              {totals.rounding > 0 ? '+' : ''}
              {formatPKR(totals.rounding)}
            </span>
          </div>
        )}

        {/* The one place this screen raises its voice. */}
        <div
          className={`border-t-2 border-ink pt-3 ${
            totals.discount > 0 || totals.rounding !== 0 ? 'mt-3' : ''
          }`}
        >
          <p className="text-meta text-ink-soft">Total</p>
          <p className="tabular mt-0.5 text-display leading-none font-semibold text-ink">
            {formatPKR(totals.total)}
          </p>
          {customer && customer.balance > 0 && (
            <p className="tabular mt-2 text-meta text-due">
              {customer.name} already owes {formatPKR(customer.balance)}
            </p>
          )}
        </div>

        {belowFloorCount > 0 && (
          <p
            className={`mt-3 rounded border px-3 py-2 text-meta ${
              enforceMinPrice ? 'border-due/30 bg-due-tint text-due' : 'border-brass/40 bg-brass-tint text-ink'
            }`}
          >
            {belowFloorCount === 1 ? 'One line is' : `${belowFloorCount} lines are`} priced below the
            minimum.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-rule p-4">
        <Button
          variant="secondary"
          onClick={onDiscount}
          disabled={cart.isEmpty}
          shortcut="F6"
          className="w-full"
        >
          Discount
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={onPay}
          disabled={cart.isEmpty}
          shortcut="F12"
          className="w-full"
        >
          Take payment
        </Button>
      </div>
    </aside>
  );
}

/**
 * One line of the running bill.
 *
 * Selecting it here is the same selection the F-keys act on, so a line can be
 * tapped in this list and then have its quantity or rate changed from the
 * keyboard without going anywhere.
 */
function CartRow({
  line,
  selected,
  landed,
  onSelect,
  onRemove,
}: {
  line: CartLine;
  selected: boolean;
  landed: boolean;
  onSelect: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const short = line.qty > line.item.qtyOnHand;

  return (
    <li
      onClick={onSelect}
      className={[
        'group relative cursor-default py-2 pr-3 pl-5 transition-colors duration-100',
        selected ? 'bg-sunk' : 'hover:bg-paper',
        landed ? 'row-landed' : '',
      ].join(' ')}
    >
      {selected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-board" aria-hidden="true" />
      )}

      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-base text-ink">{line.item.name}</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${line.item.name} from the bill`}
          className="shrink-0 rounded px-1 text-meta text-ink-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:bg-rule hover:text-due focus-visible:opacity-100"
        >
          ✕
        </button>
      </div>

      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="tabular text-meta text-ink-soft">
          {formatQty(line.qty)} {line.item.unit} ×{' '}
          <span className={line.priceEdited ? 'font-medium text-brass' : ''}>
            {formatPKR(line.unitPrice)}
          </span>
        </span>
        <span className="tabular text-row font-medium text-ink">
          {formatPKR(Math.round(line.qty * line.unitPrice))}
        </span>
      </div>

      {short && (
        <p className="text-micro text-due">
          {line.item.qtyOnHand <= 0
            ? 'none in stock'
            : `only ${formatQty(line.item.qtyOnHand)} in stock`}
        </p>
      )}
    </li>
  );
}

/** Confirmation of the bill just saved, so the cashier can read it back. */
function LastSale({ lastSale }: { lastSale: { sale: Sale; change: number } }): React.JSX.Element {
  const { sale, change } = lastSale;
  const receipt = useMutation({ mutationFn: () => api.saleReceipt(sale.id) });
  return (
    <div className="mt-6 rounded border border-board/30 bg-board-tint px-3 py-3">
      <p className="text-meta font-medium text-board">Saved as {sale.invoiceNo}</p>
      <p className="tabular mt-1 text-row text-ink">{formatPKR(sale.total)}</p>
      {change > 0 && (
        <p className="tabular mt-1 text-row font-semibold text-ink">
          Change {formatPKR(change)}
        </p>
      )}
      {sale.credit > 0 && (
        <p className="tabular mt-1 text-meta text-due">
          {formatPKR(sale.credit)} on udhaar
        </p>
      )}
      <Button
        className="mt-2.5 w-full"
        onClick={() => receipt.mutate()}
        disabled={receipt.isPending}
      >
        {receipt.isPending ? 'Making PDF…' : 'Share bill'}
      </Button>
    </div>
  );
}

/** The last few bills, so a returning customer can be looked up at a glance. */
function RecentBills(): React.JSX.Element | null {
  const recent = useQuery({ queryKey: ['sales', 'recent'], queryFn: () => api.recentSales(6) });
  const bills = recent.data ?? [];
  if (bills.length === 0) return null;

  return (
    <section className="mt-7 border-t border-rule pt-4">
      <h2 className="font-condensed text-meta font-medium text-ink-soft">Recent bills</h2>
      <ul className="mt-2 divide-y divide-rule">
        {bills.map((bill) => (
          <li key={bill.id} className="flex items-baseline justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="tabular block text-meta text-ink">{bill.invoiceNo}</span>
              <span className="block truncate text-micro text-ink-faint">
                {formatTime(bill.soldAt)}
                {bill.customerName ? ` — ${bill.customerName}` : ''}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="tabular block text-base text-ink">{formatPKR(bill.total)}</span>
              {bill.credit > 0 && (
                <span className="tabular block text-micro text-due">
                  {formatPKR(bill.credit)} udhaar
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeyBar({ canEditPrice }: { canEditPrice: boolean }): React.JSX.Element {
  const keys: Array<[string, string]> = [
    ['F2', 'Customer'],
    ['F3', 'Find item'],
    ['F4', 'Bill / browse'],
    ['F5', 'Quantity'],
    ['F6', 'Discount'],
    ['F7', 'Park bill'],
    ['F8', 'Parked'],
    ...(canEditPrice ? ([['F9', 'Rate']] as Array<[string, string]>) : []),
    ['F12', 'Pay'],
    ['Ctrl+Enter', 'Exact cash'],
    ['Del', 'Remove line'],
  ];

  return (
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-rule bg-sunk px-6 py-2">
      {keys.map(([key, label]) => (
        <span key={key} className="flex items-center gap-1.5">
          <kbd className="font-condensed rounded border border-rule-strong bg-surface px-1 text-micro font-medium text-ink-soft">
            {key}
          </kbd>
          <span className="text-micro text-ink-soft">{label}</span>
        </span>
      ))}
    </footer>
  );
}
