import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatTime } from '@pos/shared';
import { EmptyState, PageHeader, SearchInput, Select, Toolbar } from '@/components/PageHeader';
import { api, type AuditEntry } from '@/lib/api';

/**
 * The audit log.
 *
 * The promise this system makes is that a figure can always be explained. This
 * is where that promise is kept: who changed a price, who cancelled a bill, who
 * wrote off a balance, and when.
 *
 * Grouped by day and written as sentences rather than a table of codes, because
 * the person reading it is looking for one event, not auditing a system.
 */
export function ActivityScreen(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');

  const audit = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.audit({ limit: 400 }),
  });

  const rows = useMemo(() => {
    let list = audit.data ?? [];
    if (kind !== 'all') list = list.filter((entry) => entry.action.startsWith(kind));
    const needle = search.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (entry) =>
          entry.summary.toLowerCase().includes(needle) ||
          entry.userName.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [audit.data, kind, search]);

  const byDay = useMemo(() => {
    const groups = new Map<string, AuditEntry[]>();
    for (const entry of rows) {
      const day = entry.createdAt.slice(0, 10);
      const existing = groups.get(day);
      if (existing) existing.push(entry);
      else groups.set(day, [entry]);
    }
    return [...groups.entries()];
  }, [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Activity" subtitle="Everything that changed money, stock or access" />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search what happened" autoFocus />
        <Select value={kind} onChange={setKind} label="Filter by kind">
          <option value="all">Everything</option>
          <option value="sale">Bills and returns</option>
          <option value="item">Items and prices</option>
          <option value="stock">Stock</option>
          <option value="customer">Customers and payments</option>
          <option value="user">Users</option>
          <option value="settings">Settings</option>
          <option value="backup">Backups</option>
          <option value="auth">Sign-ins</option>
        </Select>
      </Toolbar>

      {audit.isPending && <p className="px-6 py-8 text-ink-soft">Loading…</p>}

      {audit.data && rows.length === 0 && (
        <EmptyState
          title={search.trim() ? `Nothing matches “${search}”` : 'Nothing recorded yet'}
          detail="Price changes, cancelled bills, stock adjustments and permission changes all appear here."
        />
      )}

      {byDay.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {byDay.map(([day, entries]) => (
            <section key={day} className="mb-6 last:mb-0">
              <h2 className="font-condensed sticky top-0 bg-paper py-1 text-meta font-medium text-ink-soft">
                {formatDate(day)}
              </h2>
              <ul className="divide-y divide-rule border-t border-rule">
                {entries.map((entry) => (
                  <li key={entry.id} className="flex items-baseline gap-4 py-2">
                    <span className="tabular w-20 shrink-0 text-meta text-ink-faint">
                      {formatTime(entry.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-base text-ink">{entry.summary}</span>
                    </span>
                    <span className="shrink-0 text-meta text-ink-soft">{entry.userName}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {rows.length >= 400 && (
            <p className="py-4 text-center text-meta text-ink-faint">
              Showing the most recent 400 entries. Narrow the search to go further back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Kept for the tooltip on a row, where the exact moment matters. */
export function auditTitle(entry: AuditEntry): string {
  return `${formatDateTime(entry.createdAt)} — ${entry.action}`;
}
