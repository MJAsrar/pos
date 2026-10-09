import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';

interface NumberPromptProps {
  open: boolean;
  title: string;
  label: string;
  description?: string;
  /** Pre-filled and selected, so typing replaces it. */
  initialValue: string;
  /** Return an error message to refuse, or null to accept. */
  validate?: (raw: string) => string | null;
  confirmLabel?: string;
  onConfirm: (raw: string) => void;
  onClose: () => void;
  /** Shown under the input, e.g. what the line total becomes. */
  hint?: (raw: string) => React.ReactNode;
}

/**
 * Ask for one number.
 *
 * Used for quantity, rate and discount at the counter. Deliberately tiny: it
 * opens with the value selected, accepts Enter, and gets out of the way.
 */
export function NumberPrompt({
  open,
  title,
  label,
  description,
  initialValue,
  validate,
  confirmLabel = 'Apply',
  onConfirm,
  onClose,
  hint,
}: NumberPromptProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setTouched(false);
    }
  }, [open, initialValue]);

  const error = validate?.(value) ?? null;

  function submit(): void {
    setTouched(true);
    if (error) return;
    onConfirm(value);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(description ? { description } : {})}
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={Boolean(error)} shortcut="Enter">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <label htmlFor="number-prompt" className="mb-1.5 block text-meta font-medium text-ink-soft">
        {label}
      </label>
      <input
        id="number-prompt"
        data-autofocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        inputMode="decimal"
        className={`tabular h-12 w-full rounded border bg-surface px-3 text-title font-medium text-ink focus:outline-none focus:ring-2 focus:ring-board/20 ${
          touched && error ? 'border-due' : 'border-rule-strong focus:border-board'
        }`}
      />
      {touched && error ? (
        <p className="mt-2 text-meta text-due">{error}</p>
      ) : hint ? (
        <p className="mt-2 text-meta text-ink-soft">{hint(value)}</p>
      ) : null}
    </Modal>
  );
}
