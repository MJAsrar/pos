import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  formatPKR,
  parseMoneyInput,
  settleSale,
  type PaymentMethod,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import type { Customer } from '@/lib/api';

interface PaymentDialogProps {
  open: boolean;
  total: number;
  customer: Customer | null;
  canSellOnCredit: boolean;
  busy: boolean;
  error?: string | undefined;
  onConfirm: (input: { paymentMethod: PaymentMethod; tendered: number }) => void;
  onClose: () => void;
  onNeedCustomer: () => void;
}

const METHODS: PaymentMethod[] = ['cash', 'wallet', 'bank', 'credit'];

/**
 * Taking payment.
 *
 * The amount received starts at the exact total, because that is what happens
 * most of the time. Typing less is not an error — the remainder goes onto the
 * customer's udhaar, which is the ordinary way this shop does business — so the
 * dialog shows that outcome plainly rather than refusing.
 */
export function PaymentDialog({
  open,
  total,
  customer,
  canSellOnCredit,
  busy,
  error,
  onConfirm,
  onClose,
  onNeedCustomer,
}: PaymentDialogProps): React.JSX.Element {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [received, setReceived] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setMethod('cash');
    setReceived(String(Math.round(total / 100)));
  }, [open, total]);

  const tendered = useMemo(() => {
    if (method === 'credit') return 0;
    return parseMoneyInput(received) ?? 0;
  }, [received, method]);

  const settlement = useMemo(
    () => settleSale(total, tendered, method),
    [total, tendered, method],
  );

  const needsCustomer = settlement.credit > 0 && !customer;
  const creditBlocked = settlement.credit > 0 && !canSellOnCredit;
  const blocked = needsCustomer || creditBlocked || busy || total <= 0;

  // Number keys pick the method, so the whole dialog is one hand on the keypad.
  useEffect(() => {
    if (!open) return undefined;
    function handleKey(event: KeyboardEvent): void {
      if (event.target instanceof HTMLInputElement && event.key !== 'Enter') return;
      const index = Number(event.key);
      if (index >= 1 && index <= METHODS.length) {
        event.preventDefault();
        setMethod(METHODS[index - 1]!);
        inputRef.current?.select();
      } else if (event.key === 'Enter' && !blocked) {
        event.preventDefault();
        onConfirm({ paymentMethod: method, tendered });
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, method, tendered, blocked, onConfirm]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take payment"
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm({ paymentMethod: method, tendered })}
            disabled={blocked}
            shortcut="Enter"
          >
            {busy ? 'Saving…' : 'Save bill'}
          </Button>
        </>
      }
    >
      <p className="text-meta text-ink-soft">Bill total</p>
      <p className="tabular mt-0.5 text-display leading-none font-semibold text-ink">
        {formatPKR(total)}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-2">
        {METHODS.map((option, index) => {
          const active = option === method;
          const disabled = option === 'credit' && !canSellOnCredit;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => setMethod(option)}
              className={[
                'flex items-center justify-between gap-2 rounded border px-3 py-2.5 text-left text-base',
                'transition-colors duration-100 disabled:cursor-not-allowed disabled:text-ink-faint',
                active
                  ? 'border-board bg-board-tint font-medium text-ink'
                  : 'border-rule-strong bg-surface text-ink-soft hover:border-ink-soft',
              ].join(' ')}
            >
              <span>{PAYMENT_METHOD_LABELS[option]}</span>
              <kbd className="font-condensed rounded border border-rule-strong px-1 text-micro text-ink-faint">
                {index + 1}
              </kbd>
            </button>
          );
        })}
      </div>

      {method !== 'credit' && (
        <div className="mt-5">
          <label htmlFor="received" className="mb-1.5 block text-meta font-medium text-ink-soft">
            Amount received
          </label>
          <input
            id="received"
            ref={inputRef}
            data-autofocus
            value={received}
            onChange={(event) => setReceived(event.target.value)}
            onFocus={(event) => event.target.select()}
            inputMode="decimal"
            className="tabular h-12 w-full rounded border border-rule-strong bg-surface px-3 text-title font-medium text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
          />
        </div>
      )}

      <dl className="mt-5 space-y-2 border-t border-rule pt-4 text-base">
        {settlement.change > 0 && (
          <Row label="Change to give back" value={formatPKR(settlement.change)} strong />
        )}
        {settlement.credit > 0 && (
          <Row
            label={method === 'credit' ? 'Going on udhaar' : 'Remaining on udhaar'}
            value={formatPKR(settlement.credit)}
            tone="due"
            strong
          />
        )}
        {customer && (
          <Row
            label={`${customer.name} will owe`}
            value={formatPKR(customer.balance + settlement.credit)}
            tone={customer.balance + settlement.credit > 0 ? 'due' : 'plain'}
          />
        )}
      </dl>

      {needsCustomer && (
        <div className="mt-4 rounded border border-brass/40 bg-brass-tint px-3 py-2.5">
          <p className="text-meta text-ink">
            {formatPKR(settlement.credit)} is left unpaid, so this bill needs a customer.
          </p>
          <button
            type="button"
            onClick={onNeedCustomer}
            className="mt-1.5 text-meta font-medium text-board underline-offset-2 hover:underline"
          >
            Choose a customer
          </button>
        </div>
      )}

      {creditBlocked && !needsCustomer && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          You are not allowed to put an amount on udhaar. Take the full payment, or ask the owner.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}
    </Modal>
  );
}

function Row({
  label,
  value,
  tone = 'plain',
  strong = false,
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'due';
  strong?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd
        className={`tabular ${strong ? 'text-section font-semibold' : ''} ${
          tone === 'due' ? 'text-due' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
