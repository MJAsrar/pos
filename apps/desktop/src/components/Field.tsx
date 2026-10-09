import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  /** Shown under the input in ledger red; also marks the input as invalid. */
  error?: string | undefined;
  /** Shown under the input when there is no error. */
  hint?: ReactNode;
}

export function Field({
  label,
  error,
  hint,
  className = '',
  ...rest
}: FieldProps): React.JSX.Element {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-meta font-medium text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
        className={[
          'h-10 w-full rounded border bg-surface px-3 text-row text-ink',
          'transition-colors duration-100',
          'focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20',
          'disabled:bg-sunk disabled:text-ink-faint',
          error ? 'border-due' : 'border-rule-strong',
        ].join(' ')}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-meta text-due">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-meta text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
