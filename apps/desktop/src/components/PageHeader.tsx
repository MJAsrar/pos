import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  /** One line of context, in the interface voice. */
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="flex items-start justify-between gap-6 border-b border-rule px-6 py-3.5">
      <div className="min-w-0">
        <h1 className="text-section font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-meta text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The bar under a page header holding search boxes and filters. */
export function Toolbar({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-surface px-6 py-2.5">
      {children}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  className = 'w-72',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={placeholder}
      className={`h-9 rounded border border-rule-strong bg-paper px-3 text-base text-ink placeholder:text-ink-faint focus:border-board focus:bg-surface focus:outline-none focus:ring-2 focus:ring-board/20 ${className}`}
    />
  );
}

export function Select({
  value,
  onChange,
  children,
  label,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      className={`h-9 rounded border border-rule-strong bg-paper px-2 text-base text-ink focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20 ${className}`}
    >
      {children}
    </select>
  );
}

/** Shown in place of a table when there is nothing to list. */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-section text-ink-soft">{title}</p>
      {detail && <p className="max-w-sm text-meta text-ink-faint">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
