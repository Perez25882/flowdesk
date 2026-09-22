import { useRef, useState } from 'react';
import { AlertTriangle, Check, FileUp, Upload } from 'lucide-react';
import {
  readFileAsText,
  useCommitImport,
  usePreviewImport,
  type ImportPreview,
} from '@/hooks/useProducts';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/utils';

/**
 * Loading a catalogue from a spreadsheet.
 *
 * Two steps, always. The catalogue is what the assistant answers from, so an
 * import that silently created three hundred slightly-wrong products would
 * poison every reply afterwards and take an evening to undo by hand. The
 * preview is what makes this safe to try, and "safe to try" is the whole
 * difference between a shop that has a catalogue and one that keeps meaning to
 * make one.
 */
export default function ImportCatalogue({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const previewImport = usePreviewImport();
  const commitImport = useCommitImport();

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setReadError(null);
    setPreview(null);

    try {
      const text = await readFileAsText(file);
      setCsv(text);
      setFileName(file.name);
      const result = await previewImport.mutateAsync(text);
      setPreview(result);
    } catch (error: unknown) {
      setReadError(error instanceof Error ? error.message : 'That file could not be read.');
    }
  }

  if (commitImport.isSuccess) {
    const { created, updated, failed } = commitImport.data;
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Check className="h-4 w-4 text-success" strokeWidth={2} aria-hidden="true" />
          {created} added{updated > 0 ? `, ${updated} updated` : ''}.
        </p>

        {failed.length > 0 && (
          <div className="rounded-md border border-border bg-surface-hover p-3">
            <p className="text-sm text-text-primary">{failed.length} row(s) were skipped:</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {failed.slice(0, 10).map((error) => (
                <li key={error.line} className="text-xs text-text-muted">
                  Row {error.line}: {error.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fileInput.current?.click()}
          isLoading={previewImport.isPending}
          leadingIcon={<FileUp className="h-4 w-4" strokeWidth={2} />}
        >
          {fileName || 'Choose a CSV file'}
        </Button>

        <a
          href="/api/v1/products/import/template"
          download
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          Download a template
        </a>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="sr-only"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      <p className="text-xs text-text-muted">
        Needs a name and a price column. Everything else, from unit and stock to reorder level and other
        names and product code, is used if it is there and skipped if it is not.
      </p>

      {readError && (
        <p role="alert" className="text-sm text-danger">
          {readError}
        </p>
      )}

      {previewImport.isError && (
        <p role="alert" className="text-sm text-danger">
          {previewImport.error.message}
        </p>
      )}

      {preview && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-4 rounded-md border border-border bg-surface-hover p-3 text-sm">
            <span className="text-text-primary">
              <span className="fd-figure font-semibold">{preview.summary.toCreate}</span> new
            </span>
            <span className="text-text-primary">
              <span className="fd-figure font-semibold">{preview.summary.toUpdate}</span> already
              in your catalogue
            </span>
            {preview.summary.failed > 0 && (
              <span className="text-warning">
                <span className="fd-figure font-semibold">{preview.summary.failed}</span> row(s)
                to skip
              </span>
            )}
          </div>

          {preview.summary.wouldExceedPlan && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" strokeWidth={2} aria-hidden="true" />
              This file would take you past your plan&rsquo;s {preview.summary.allowed} products.
              Nothing is imported until that is sorted, so the catalogue is never left half
              loaded.
            </p>
          )}

          {preview.errors.length > 0 && (
            <div className="rounded-md border border-border p-3">
              <p className="text-sm font-medium text-text-primary">
                These rows will be skipped
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {preview.errors.slice(0, 8).map((error) => (
                  <li key={`${error.line}-${error.message}`} className="text-xs text-text-muted">
                    Row {error.line}: {error.message}
                  </li>
                ))}
                {preview.errors.length > 8 && (
                  <li className="text-xs text-text-muted">
                    …and {preview.errors.length - 8} more.
                  </li>
                )}
              </ul>
            </div>
          )}

          {preview.rows.length > 0 && (
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-hover text-left text-xs text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">Price</th>
                    <th className="px-3 py-2 font-medium">Stock</th>
                    <th className="px-3 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {preview.rows.slice(0, 12).map((row) => (
                    <tr key={row.line}>
                      <td className="px-3 py-2 text-text-primary">
                        {row.name}
                        <span className="text-text-muted"> / {row.unit}</span>
                      </td>
                      <td className="fd-figure px-3 py-2 text-text-primary">
                        {formatCurrency(row.price)}
                      </td>
                      <td className="fd-figure px-3 py-2 text-text-secondary">
                        {row.stockQuantity}
                      </td>
                      <td className="px-3 py-2 text-xs text-text-muted">
                        {row.existingProductId ? 'update' : 'new'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rows.length > 12 && (
                <p className="border-t border-border-subtle px-3 py-2 text-xs text-text-muted">
                  Showing 12 of {preview.rows.length}.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              onClick={() =>
                csv && commitImport.mutate({ csv, updateExisting: true })
              }
              disabled={
                !csv || preview.rows.length === 0 || preview.summary.wouldExceedPlan
              }
              isLoading={commitImport.isPending}
              leadingIcon={<Upload className="h-4 w-4" strokeWidth={2} />}
            >
              Import {preview.rows.length} product{preview.rows.length === 1 ? '' : 's'}
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>

          {commitImport.isError && (
            <p role="alert" className="text-sm text-danger">
              {commitImport.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
