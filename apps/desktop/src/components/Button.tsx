import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
type Size = 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Keyboard shortcut shown on the button, e.g. `F12`. */
  shortcut?: string;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-board text-white hover:bg-board-dark active:bg-board-dark disabled:bg-rule-strong',
  secondary:
    'bg-surface text-ink border border-rule-strong hover:border-ink-soft hover:bg-sunk disabled:text-ink-faint',
  quiet: 'bg-transparent text-ink-soft hover:bg-sunk hover:text-ink disabled:text-ink-faint',
  danger: 'bg-due text-white hover:brightness-90 disabled:bg-rule-strong',
};

const SIZES: Record<Size, string> = {
  md: 'h-9 px-3.5 text-base gap-2',
  lg: 'h-12 px-5 text-section gap-2.5',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  shortcut,
  className = '',
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={[
        'inline-flex items-center justify-center rounded font-medium',
        'transition-colors duration-100 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(' ')}
    >
      {children}
      {shortcut && <Shortcut variant={variant}>{shortcut}</Shortcut>}
    </button>
  );
}

/**
 * The key that does the same thing, shown on the control itself.
 *
 * Staff learn the keyboard by reading it off the buttons for the first week and
 * then never touching the mouse again, so these are permanent rather than a
 * tooltip that has to be discovered.
 */
function Shortcut({ variant, children }: { variant: Variant; children: ReactNode }): React.JSX.Element {
  const tone =
    variant === 'primary' || variant === 'danger'
      ? 'border-white/30 text-white/80'
      : 'border-rule-strong text-ink-faint';
  return (
    <kbd
      className={`font-condensed rounded border px-1 text-micro leading-4 font-medium ${tone}`}
    >
      {children}
    </kbd>
  );
}
