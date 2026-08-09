import { useState } from 'react';
import { Minus, Package, Plus } from 'lucide-react';
import {
  useProducts,
  useCreateProduct,
  useUpdateProduct,
  useAdjustStock,
} from '@/hooks/useProducts';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import SearchInput from '@/components/ui/SearchInput';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatCurrency, cn } from '@/lib/utils';

const EMPTY_FORM = {
  name: '',
  unit: '',
  price: '',
  stockQuantity: '',
  reorderThreshold: '',
  aliases: '',
};

/**
 * The catalogue.
 *
 * Two changes worth naming. The stock +/- controls were unlabelled icon
 * buttons, so a screen reader announced two identical "button"s next to a
 * number; they now say what they change and by how much. And the aliases
 * field, which is the thing that actually makes message matching work, was
 * presented as an afterthought labelled "Aliases (comma separated)" — it now
 * explains itself, because a shop owner has no reason to know what an alias is.
 */
export default function ProductsPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: products, isLoading } = useProducts(search || undefined);
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const adjustStock = useAdjustStock();

  const isSaving = createProduct.isPending || updateProduct.isPending;
  const canSave = form.name.trim().length > 0 && form.price.trim().length > 0;

  function closeForm(): void {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function handleSubmit(): void {
    const data = {
      name: form.name.trim(),
      unit: form.unit.trim(),
      price: Number(form.price),
      stockQuantity: Number(form.stockQuantity) || 0,
      reorderThreshold: Number(form.reorderThreshold) || 0,
      aliases: form.aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    };

    if (editingId) {
      updateProduct.mutate({ id: editingId, data }, { onSuccess: closeForm });
    } else {
      createProduct.mutate(data, { onSuccess: closeForm });
    }
  }

  function startEdit(product: {
    id: string;
    name: string;
    unit: string;
    price: number;
    stockQuantity: number;
    reorderThreshold: number;
    aliases: string[];
  }): void {
    setForm({
      name: product.name,
      unit: product.unit,
      price: String(product.price),
      stockQuantity: String(product.stockQuantity),
      reorderThreshold: String(product.reorderThreshold),
      aliases: product.aliases.join(', '),
    });
    setEditingId(product.id);
    setShowForm(true);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Products"
        description="What you sell, and how much is left."
        actions={
          <>
            <SearchInput
              label="Search products"
              placeholder="Search products"
              value={search}
              onChange={setSearch}
              className="w-full sm:w-56"
            />
            <Button
              size="sm"
              variant={showForm ? 'secondary' : 'primary'}
              onClick={() => (showForm ? closeForm() : setShowForm(true))}
              leadingIcon={showForm ? undefined : <Plus className="h-4 w-4" strokeWidth={2} />}
            >
              {showForm ? 'Cancel' : 'Add product'}
            </Button>
          </>
        }
      />

      {showForm && (
        <Panel>
          <PanelHead title={editingId ? 'Edit product' : 'New product'} />

          <div className="p-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">Name</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Jasmine rice"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">Sold by</span>
                <input
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  placeholder="bag, crate, kg"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">Price, in cedis</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="92.00"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">In stock now</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={form.stockQuantity}
                  onChange={(e) => setForm({ ...form, stockQuantity: e.target.value })}
                  placeholder="40"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-primary">Warn me below</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={form.reorderThreshold}
                  onChange={(e) => setForm({ ...form, reorderThreshold: e.target.value })}
                  placeholder="8"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </label>

              <label className="flex flex-col gap-1.5 lg:col-span-3">
                <span className="text-sm font-medium text-text-primary">
                  Other names customers use
                </span>
                <input
                  value={form.aliases}
                  onChange={(e) => setForm({ ...form, aliases: e.target.value })}
                  placeholder="rice, jasmin, 5kg rice"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
                <span className="text-xs text-text-muted">
                  Separate with commas. Lets Flowdesk match &ldquo;5kg rice&rdquo; to this product.
                </span>
              </label>
            </div>

            <div className="mt-5 flex items-center gap-2">
              <Button onClick={handleSubmit} disabled={!canSave} isLoading={isSaving}>
                {editingId ? 'Save changes' : 'Add product'}
              </Button>
              <Button variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <Panel>
        {isLoading && <SkeletonRows count={6} />}

        {!isLoading && (!products || products.length === 0) && (
          <EmptyState
            icon={Package}
            title={search ? 'No matches' : 'Nothing in the catalogue'}
            description={
              search
                ? 'Nothing matched that.'
                : 'Add what you sell so Flowdesk can spot it in messages.'
            }
            {...(search ? {} : { action: { label: 'Add your first product', onClick: () => setShowForm(true) } })}
          />
        )}

        {!isLoading && products && products.length > 0 && (
          <RowList>
            {products.map((product) => {
              const isLow =
                product.reorderThreshold > 0 && product.stockQuantity <= product.reorderThreshold;

              return (
                <Row key={product.id} className="flex-wrap gap-y-2">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {product.name}
                    </span>
                    <span className="text-xs text-text-muted">
                      <span className="fd-figure">{formatCurrency(product.price)}</span>
                      {product.unit ? ` per ${product.unit}` : ''}
                      {product.aliases.length > 0 && ` · also called ${product.aliases.slice(0, 3).join(', ')}`}
                    </span>
                  </span>

                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-right">
                      <span
                        className={cn(
                          'fd-figure block text-sm font-semibold',
                          isLow ? 'text-warning' : 'text-text-primary',
                        )}
                      >
                        {product.stockQuantity}
                      </span>
                      <span className="text-2xs text-text-muted">
                        {isLow ? `low, warn at ${product.reorderThreshold}` : 'in stock'}
                      </span>
                    </span>

                    <span className="flex items-center rounded-md border border-border">
                      <button
                        type="button"
                        onClick={() =>
                          adjustStock.mutate({
                            id: product.id,
                            data: { quantity: -1, type: 'ADJUSTMENT' },
                          })
                        }
                        disabled={product.stockQuantity <= 0}
                        aria-label={`Remove one ${product.name} from stock`}
                        className="flex h-11 w-11 items-center justify-center rounded-l-[5px] text-text-secondary transition-colors duration-fast ease-out hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:h-9 sm:w-9"
                      >
                        <Minus className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      <span className="h-11 w-px bg-border sm:h-9" aria-hidden="true" />
                      <button
                        type="button"
                        onClick={() =>
                          adjustStock.mutate({
                            id: product.id,
                            data: { quantity: 1, type: 'RESTOCK' },
                          })
                        }
                        aria-label={`Add one ${product.name} to stock`}
                        className="flex h-11 w-11 items-center justify-center rounded-r-[5px] text-text-secondary transition-colors duration-fast ease-out hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:h-9 sm:w-9"
                      >
                        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                    </span>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startEdit(product)}
                      aria-label={`Edit ${product.name}`}
                    >
                      Edit
                    </Button>
                  </span>
                </Row>
              );
            })}
          </RowList>
        )}
      </Panel>
    </div>
  );
}
