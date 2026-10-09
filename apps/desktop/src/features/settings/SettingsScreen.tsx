import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatPKR, formatQty, type ShopSettings } from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { PageHeader } from '@/components/PageHeader';
import { Modal } from '@/components/Modal';
import { ApiError, api, type BackupFile } from '@/lib/api';

/**
 * Shop details, selling rules, and the health of the data.
 *
 * The data-check section exists because two figures in this system are caches —
 * stock on hand and each customer's balance. Both are written inside the same
 * transaction as the records they summarise, so they should never drift; a cache
 * nobody can verify is a cache nobody should trust.
 */
export function SettingsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [form, setForm] = useState<ShopSettings | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (patch: Partial<ShopSettings>) => api.saveSettings(patch),
    onSuccess: (updated) => {
      setForm(updated);
      setSavedAt(new Date().toISOString());
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['app.status'] });
    },
  });

  const set = <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]): void =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const error = save.error instanceof ApiError ? save.error.message : undefined;

  if (!form) return <p className="px-6 py-8 text-ink-soft">Loading…</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Settings"
        subtitle={savedAt ? `Saved ${formatDateTime(savedAt)}` : 'Shop details, selling rules and backups'}
        actions={
          <Button
            variant="primary"
            onClick={() => save.mutate(form)}
            disabled={save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-3xl space-y-8">
          <Section
            title="On every receipt"
            detail="This is what a customer sees at the top of their bill."
          >
            <LogoField />
            <Field
              label="Shop name"
              value={form.shopName}
              onChange={(event) => set('shopName', event.target.value)}
              maxLength={80}
            />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Address"
                value={form.addressLine1}
                onChange={(event) => set('addressLine1', event.target.value)}
                maxLength={120}
              />
              <Field
                label="Phone number"
                value={form.phone}
                onChange={(event) => set('phone', event.target.value)}
                inputMode="tel"
                maxLength={40}
              />
            </div>
            <Field
              label="Note at the bottom of the bill"
              value={form.footerNote}
              onChange={(event) => set('footerNote', event.target.value)}
              maxLength={300}
              hint="Return terms, thanks, anything you want printed."
            />
          </Section>

          <Section title="Bill numbers">
            <Field
              className="max-w-xs"
              label="Prefix"
              value={form.invoicePrefix}
              onChange={(event) => set('invoicePrefix', event.target.value.toUpperCase())}
              maxLength={8}
              hint={`Bills will be numbered ${form.invoicePrefix || 'AH'}-00001, ${form.invoicePrefix || 'AH'}-00002 and so on.`}
            />
          </Section>

          <Section title="Selling rules">
            <Toggle
              checked={form.enforceMinPrice}
              onChange={(value) => set('enforceMinPrice', value)}
              label="Stop staff selling below an item's lowest price"
              detail="When off, a low price is only a warning. You can always go below it yourself."
            />
            <Toggle
              checked={form.blockNegativeStock}
              onChange={(value) => set('blockNegativeStock', value)}
              label="Stop a sale when there is not enough stock"
              detail="Most shops leave this off — the shelf is often right and the record behind."
            />
          </Section>

          {error && (
            <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
              {error}
            </p>
          )}

          <DataHealth />
          <Backups />
        </div>
      </div>
    </div>
  );
}

/** The shop logo, printed at the top of every receipt and statement. */
function LogoField(): React.JSX.Element {
  const queryClient = useQueryClient();
  const logo = useQuery({ queryKey: ['shopLogo'], queryFn: api.shopLogo });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['shopLogo'] });
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  const choose = useMutation({
    mutationFn: api.chooseShopLogo,
    onSuccess: (result) => { if (!result.cancelled) refresh(); },
  });
  const clear = useMutation({ mutationFn: api.clearShopLogo, onSuccess: refresh });

  const error = choose.error instanceof ApiError ? choose.error.message : undefined;
  const url = logo.data?.dataUrl ?? null;

  return (
    <div>
      <span className="mb-2 block text-meta font-medium text-ink-soft">Logo</span>
      <div className="flex items-center gap-4">
        <span className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded border border-rule-strong bg-sunk">
          {url ? (
            <img src={url} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-micro text-ink-faint">no logo</span>
          )}
        </span>
        <div className="flex gap-2">
          <Button onClick={() => choose.mutate()} disabled={choose.isPending}>
            {choose.isPending ? 'Opening…' : url ? 'Change logo' : 'Choose a logo'}
          </Button>
          {url && (
            <Button variant="quiet" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-meta text-due">{error}</p>}
    </div>
  );
}

function DataHealth(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.checkData>> | null>(null);

  const check = useMutation({ mutationFn: api.checkData, onSuccess: setResult });
  const repair = useMutation({
    mutationFn: api.repairStock,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      check.mutate();
    },
  });

  const clean = result && result.stock.length === 0 && result.ledger.length === 0;

  return (
    <Section
      title="Check the figures"
      detail="Compares every stock level and customer balance against the history behind it."
    >
      <div className="flex items-center gap-3">
        <Button onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? 'Checking…' : 'Run the check'}
        </Button>
        {clean && <span className="text-meta text-board">Everything matches its history.</span>}
      </div>

      {result && result.stock.length > 0 && (
        <div className="rounded border border-brass/40 bg-brass-tint px-3 py-3">
          <p className="text-meta font-medium text-ink">
            {result.stock.length} stock {result.stock.length === 1 ? 'figure does' : 'figures do'} not
            match their history
          </p>
          <ul className="mt-2 space-y-0.5">
            {result.stock.slice(0, 8).map((row) => (
              <li key={row.itemId} className="tabular text-meta text-ink-soft">
                {row.name}: shows {formatQty(row.cached)}, history says {formatQty(row.fromMovements)}
              </li>
            ))}
          </ul>
          <Button
            className="mt-3"
            onClick={() => repair.mutate()}
            disabled={repair.isPending}
          >
            {repair.isPending ? 'Fixing…' : 'Rebuild from history'}
          </Button>
        </div>
      )}

      {result && result.ledger.length > 0 && (
        <div className="rounded border border-due/30 bg-due-tint px-3 py-3">
          <p className="text-meta font-medium text-due">
            {result.ledger.length} customer {result.ledger.length === 1 ? 'balance does' : 'balances do'}{' '}
            not match their khata
          </p>
          <ul className="mt-2 space-y-0.5">
            {result.ledger.slice(0, 8).map((row) => (
              <li key={row.customerId} className="tabular text-meta text-ink">
                {row.name}: shows {formatPKR(row.cached)}, khata says {formatPKR(row.fromEntries)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-ink">
            Do not settle any of these accounts until someone has looked at it.
          </p>
        </div>
      )}
    </Section>
  );
}

function Backups(): React.JSX.Element {
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups });
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState<BackupFile | null>(null);

  const create = useMutation({
    mutationFn: api.createBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });

  const error = create.error instanceof ApiError ? create.error.message : undefined;

  return (
    <Section
      title="Backups"
      detail="A copy is saved automatically every time the app opens and closes. Keep one on a USB stick too."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
        <Button onClick={() => void api.openFolder('backups')}>Open the backups folder</Button>
        <Button onClick={() => void api.openFolder('receipts')}>Open the receipts folder</Button>
      </div>

      {error && (
        <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}

      {backups.data && backups.data.length > 0 && (
        <ul className="divide-y divide-rule border-y border-rule">
          {backups.data.slice(0, 8).map((backup) => (
            <li key={backup.name} className="group flex items-center justify-between gap-4 py-2">
              <span className="min-w-0">
                <span className="tabular block truncate text-base text-ink">{backup.name}</span>
                <span className="tabular block text-meta text-ink-soft">
                  {formatDateTime(backup.createdAt)} — {Math.round(backup.sizeBytes / 1024)} KB
                </span>
              </span>
              <Button
                variant="quiet"
                onClick={() => setRestoring(backup)}
                className="shrink-0 opacity-60 transition-opacity duration-100 group-hover:opacity-100"
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-meta text-ink-faint">
        Restore one once, on purpose, so you know it works before you ever need it.
      </p>

      <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />
    </Section>
  );
}

/**
 * Putting a backup back.
 *
 * The most destructive thing in the app, so it says plainly what is about to
 * happen in both directions: what comes back, and what goes away. The file is
 * checked before anything is touched, and today's data is copied aside first,
 * so even choosing the wrong backup is recoverable.
 */
function RestoreDialog({
  backup,
  onClose,
}: {
  backup: BackupFile | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const [confirmed, setConfirmed] = useState(false);

  const inspect = useQuery({
    queryKey: ['backupInspect', backup?.path],
    queryFn: () => api.inspectBackup(backup!.path),
    enabled: Boolean(backup),
    retry: false,
  });

  const restore = useMutation({ mutationFn: () => api.restoreBackup(backup!.path) });

  useEffect(() => {
    setConfirmed(false);
    restore.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backup?.path]);

  if (!backup) return null;

  const problem =
    inspect.error instanceof ApiError
      ? inspect.error.message
      : restore.error instanceof ApiError
        ? restore.error.message
        : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title="Restore this backup?"
      description={formatDateTime(backup.createdAt)}
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={restore.isPending}>
            Keep what I have
          </Button>
          <Button
            variant="danger"
            onClick={() => restore.mutate()}
            disabled={!confirmed || !inspect.data || restore.isPending}
          >
            {restore.isPending ? 'Restoring…' : 'Restore and restart'}
          </Button>
        </>
      }
    >
      {inspect.isPending && <p className="text-ink-soft">Checking the backup…</p>}

      {inspect.data && (
        <>
          <p className="text-base text-ink">
            This backup holds{' '}
            <span className="font-medium">
              {inspect.data.sales} {inspect.data.sales === 1 ? 'bill' : 'bills'}
            </span>
            . Everything recorded since it was taken will no longer be in the app.
          </p>

          <ul className="mt-3 space-y-1 text-base text-ink-soft">
            <li>Today&apos;s data is copied aside first, so this can be undone.</li>
            <li>The app closes and opens again by itself.</li>
            <li>You will need to sign in afterwards.</li>
          </ul>

          <label className="mt-4 flex items-start gap-2.5 text-base text-ink">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 size-4 accent-due"
            />
            I understand this replaces the shop&apos;s current records.
          </label>
        </>
      )}

      {restore.data && (
        <p className="mt-4 rounded border border-board/30 bg-board-tint px-3 py-2.5 text-meta text-board">
          Restored. The app is restarting now.
        </p>
      )}

      {problem && (
        <p className="mt-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {problem}
        </p>
      )}
    </Modal>
  );
}


function Section({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="border-t border-rule pt-5 first:border-t-0 first:pt-0">
      <h2 className="text-section font-semibold text-ink">{title}</h2>
      {detail && <p className="mt-0.5 mb-4 max-w-xl text-meta text-ink-soft">{detail}</p>}
      <div className={`${detail ? '' : 'mt-4'} space-y-4`}>{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  detail,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  detail: string;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-board"
      />
      <span>
        <span className="block text-base text-ink">{label}</span>
        <span className="block text-meta text-ink-soft">{detail}</span>
      </span>
    </label>
  );
}
