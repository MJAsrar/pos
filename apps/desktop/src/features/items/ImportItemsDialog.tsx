import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPKR, formatQty } from '@pos/shared';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ApiError, api, type ImportPreview } from '@/lib/api';

/**
 * Bring the item list in from Excel.
 *
 * Two steps on purpose: read the file and show exactly what will happen, then
 * do it. The first list a shop loads is the one they are least sure about, and
 * "42 will be added, 3 updated" is a far better thing to see than a spinner
 * followed by a surprise.
 */
export function ImportItemsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [done, setDone] = useState<{ added: number; updated: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const read = useMutation({
    mutationFn: api.previewImport,
    onSuccess: setPreview,
  });

  const apply = useMutation({
    mutationFn: () => api.applyImport(preview!.rows),
    onSuccess: (result) => {
      setDone(result);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  function reset(): void {
    setPreview(null);
    setFileName('');
    setDone(null);
    read.reset();
    apply.reset();
  }

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    reset();
    setFileName(file.name);
    read.mutate(await file.text());
  }

  const error =
    read.error instanceof ApiError
      ? read.error.message
      : apply.error instanceof ApiError
        ? apply.error.message
        : undefined;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Bring in an item list"
      description="A spreadsheet saved as CSV. It needs a name and a price; code, cost, quantity and unit are used if they are there."
      width="lg"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={apply.isPending}
          >
            {done ? 'Done' : 'Cancel'}
          </Button>
          {preview && preview.rows.length > 0 && (
            <Button variant="primary" onClick={() => apply.mutate()} disabled={apply.isPending}>
              {apply.isPending
                ? 'Importing…'
                : `Import ${preview.rows.length} ${preview.rows.length === 1 ? 'item' : 'items'}`}
            </Button>
          )}
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={(event) => void pick(event.target.files?.[0])}
        className="hidden"
      />

      {!preview && !done && (
        <div className="py-6 text-center">
          <Button variant="primary" size="lg" onClick={() => fileRef.current?.click()} data-autofocus>
            {read.isPending ? 'Reading…' : 'Choose a CSV file'}
          </Button>
          <p className="mt-4 text-meta text-ink-soft">
            In Excel: File → Save As → CSV. Column names can be anything sensible —
            &ldquo;Item&rdquo;, &ldquo;Rate&rdquo;, &ldquo;Stock&rdquo; are all understood.
          </p>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}

      {done && (
        <p className="rounded border border-board/30 bg-board-tint px-3 py-3 text-base text-board">
          Imported {done.added} new {done.added === 1 ? 'item' : 'items'}
          {done.updated > 0 ? ` and updated ${done.updated}` : ''}.
        </p>
      )}

      {preview && (
        <>
          <p className="mb-3 text-base text-ink">
            <span className="font-medium">{fileName}</span> — {preview.toAdd} to add
            {preview.toUpdate > 0 ? `, ${preview.toUpdate} already here and will be updated` : ''}.
          </p>

          {preview.newCategories.length > 0 && (
            <p className="mb-3 text-meta text-ink-soft">
              New {preview.newCategories.length === 1 ? 'category' : 'categories'} will be created:{' '}
              <span className="text-ink">{preview.newCategories.join(', ')}</span>
            </p>
          )}

          {preview.problems.length > 0 && (
            <div className="mb-4 rounded border border-brass/40 bg-brass-tint px-3 py-2.5">
              <p className="text-meta font-medium text-ink">
                {preview.problems.length} {preview.problems.length === 1 ? 'row was' : 'rows were'}{' '}
                skipped
              </p>
              <ul className="mt-1 space-y-0.5">
                {preview.problems.slice(0, 6).map((problem) => (
                  <li key={problem.line} className="text-meta text-ink-soft">
                    Line {problem.line}: {problem.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-rule-strong">
                {['Code', 'Item', 'Qty', 'Cost', 'Price', ''].map((label, index) => (
                  <th
                    key={label + index}
                    scope="col"
                    className={`font-condensed pb-2 text-meta font-medium text-ink-soft ${
                      index >= 2 && index <= 4 ? 'pl-4 text-right' : 'text-left'
                    }`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 50).map((row) => (
                <tr key={row.line} className="border-b border-rule">
                  <td className="tabular py-1.5 pr-4 text-meta text-ink-soft">{row.code}</td>
                  <td className="py-1.5 pr-4 text-base text-ink">{row.name}</td>
                  <td className="tabular py-1.5 pl-4 text-right text-base text-ink-soft">
                    {formatQty(row.openingQty)} {row.unit}
                  </td>
                  <td className="tabular py-1.5 pl-4 text-right text-base text-ink-soft">
                    {formatPKR(row.costPrice)}
                  </td>
                  <td className="tabular py-1.5 pl-4 text-right text-base font-medium text-ink">
                    {formatPKR(row.salePrice)}
                  </td>
                  <td className="py-1.5 pl-4 text-meta text-brass">
                    {row.existingId ? 'update' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {preview.rows.length > 50 && (
            <p className="mt-3 text-meta text-ink-faint">
              and {preview.rows.length - 50} more.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
