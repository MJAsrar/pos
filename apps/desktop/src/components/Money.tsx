import { formatPKR, formatQty as formatQuantity, type Unit } from '@pos/shared';

interface MoneyProps {
  value: number | null;
  /** Colour by sign: red when owed, green when in the shop's favour. */
  tone?: 'plain' | 'ledger' | 'muted';
  className?: string;
  /** What to show when the value is hidden by permissions. */
  hidden?: string;
}

/**
 * A money amount.
 *
 * Always tabular, so a column of figures lines up digit for digit — a column
 * that does not align cannot be scanned, and scanning is the whole job.
 *
 * `null` means the signed-in user is not allowed to see this figure, which is
 * different from zero and is shown as such.
 */
export function Money({
  value,
  tone = 'plain',
  className = '',
  hidden = '—',
}: MoneyProps): React.JSX.Element {
  if (value === null) {
    return <span className={`tabular text-ink-faint ${className}`}>{hidden}</span>;
  }

  const colour =
    tone === 'muted'
      ? 'text-ink-soft'
      : tone === 'ledger'
        ? value > 0
          ? 'text-due'
          : value < 0
            ? 'text-board'
            : 'text-ink-soft'
        : 'text-ink';

  return <span className={`tabular ${colour} ${className}`}>{formatPKR(value)}</span>;
}

/** A quantity with its unit, e.g. `2.5 mtr`. */
export function Qty({
  value,
  unit,
  className = '',
}: {
  value: number;
  unit?: Unit | string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={`tabular ${className}`}>
      {formatQuantity(value)}
      {unit && <span className="ml-1 text-ink-faint">{unit}</span>}
    </span>
  );
}

/**
 * A column heading in a data table.
 *
 * Condensed and in sentence case rather than tracked-out capitals: it needs to
 * read as a label without shouting over the figures it sits above.
 */
export function ColumnHead({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}): React.JSX.Element {
  const alignment =
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      scope="col"
      className={`font-condensed pb-2 text-meta font-medium text-ink-soft ${alignment} ${className}`}
    >
      {children}
    </th>
  );
}
