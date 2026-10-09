import { useEffect } from 'react';

interface PinPadProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired when the last digit is entered, so nobody has to press Enter. */
  onComplete?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  /** Shakes the dots and is announced to screen readers. */
  error?: string | undefined;
}

/**
 * Four-digit PIN entry.
 *
 * Both a keypad and a keyboard target: the owner will type, staff standing at
 * the counter often prefer to tap. Keystrokes are captured at the document
 * level while this is mounted, so the cashier never has to click the field
 * first — the PIN screen is always listening.
 */
export function PinPad({
  value,
  onChange,
  onComplete,
  length = 4,
  disabled = false,
  error,
}: PinPadProps): React.JSX.Element {
  useEffect(() => {
    if (disabled) return undefined;

    function handleKey(event: KeyboardEvent): void {
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        if (value.length < length) {
          const next = value + event.key;
          onChange(next);
          if (next.length === length) onComplete?.(next);
        }
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        onChange(value.slice(0, -1));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onChange('');
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [value, length, disabled, onChange, onComplete]);

  function press(digit: string): void {
    if (disabled || value.length >= length) return;
    const next = value + digit;
    onChange(next);
    if (next.length === length) onComplete?.(next);
  }

  return (
    <div>
      <div className="flex justify-center gap-3" role="status" aria-live="polite" aria-label={`${value.length} of ${length} digits entered`}>
        {Array.from({ length }, (_, index) => {
          const filled = index < value.length;
          return (
            <span
              key={index}
              className={[
                'h-14 w-12 rounded border-2 transition-colors duration-100',
                'flex items-center justify-center',
                error ? 'border-due' : filled ? 'border-board' : 'border-rule-strong',
              ].join(' ')}
            >
              {filled && (
                <span className={`h-3 w-3 rounded-full ${error ? 'bg-due' : 'bg-board'}`} />
              )}
            </span>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-center text-meta text-due" role="alert">
          {error}
        </p>
      )}

      <div className="mx-auto mt-6 grid w-60 grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <PadKey key={digit} onClick={() => press(digit)} disabled={disabled}>
            {digit}
          </PadKey>
        ))}
        <PadKey onClick={() => onChange('')} disabled={disabled || value.length === 0} muted>
          Clear
        </PadKey>
        <PadKey onClick={() => press('0')} disabled={disabled}>
          0
        </PadKey>
        <PadKey
          onClick={() => onChange(value.slice(0, -1))}
          disabled={disabled || value.length === 0}
          muted
        >
          Back
        </PadKey>
      </div>
    </div>
  );
}

function PadKey({
  children,
  onClick,
  disabled,
  muted = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      tabIndex={-1}
      className={[
        'h-12 rounded border border-rule-strong bg-surface',
        'transition-colors duration-100 hover:bg-sunk active:bg-rule',
        'disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-surface',
        muted ? 'text-meta font-medium text-ink-soft' : 'tabular text-section font-medium text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
