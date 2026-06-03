import { useState } from 'react';
import { Search, Package, Plus, Minus, AlertTriangle } from 'lucide-react';
import { useProducts, useCreateProduct, useUpdateProduct, useAdjustStock } from '@/hooks/useProducts';
import EmptyState from '@/components/shared/EmptyState';
import { formatCurrency } from '@/lib/utils';

export default function ProductsPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', unit: '', price: '', stockQuantity: '', reorderThreshold: '', aliases: '' });

  const { data: products, isLoading } = useProducts(search || undefined);
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const adjustStock = useAdjustStock();

  const handleSubmit = () => {
    const data = {
      name: form.name,
      unit: form.unit,
      price: Number(form.price),
      stockQuantity: Number(form.stockQuantity) || 0,
      reorderThreshold: Number(form.reorderThreshold) || 0,
      aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
    };
    if (editingId) {
      updateProduct.mutate({ id: editingId, data }, { onSuccess: () => { setShowForm(false); setEditingId(null); } });
    } else {
      createProduct.mutate(data, { onSuccess: () => { setShowForm(false); setForm({ name: '', unit: '', price: '', stockQuantity: '', reorderThreshold: '', aliases: '' }); } });
    }
  };

  const startEdit = (product: { id: string; name: string; unit: string; price: number; stockQuantity: number; reorderThreshold: number; aliases: string[] }) => {
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
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Products</h1>
        <button
          onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ name: '', unit: '', price: '', stockQuantity: '', reorderThreshold: '', aliases: '' }); }}
          className="flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-light)]"
        >
          <Plus className="h-4 w-4" /> {showForm ? 'Cancel' : 'Add Product'}
        </button>
      </div>

      {showForm && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Product name" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="Unit (bag, piece, kg)" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="Price (GHS)" type="number" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={form.stockQuantity} onChange={(e) => setForm({ ...form, stockQuantity: e.target.value })} placeholder="Stock quantity" type="number" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={form.reorderThreshold} onChange={(e) => setForm({ ...form, reorderThreshold: e.target.value })} placeholder="Reorder threshold" type="number" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="Aliases (comma separated)" className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
          </div>
          <button onClick={handleSubmit} className="mt-3 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-light)]">
            {editingId ? 'Update Product' : 'Create Product'}
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products..."
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-4 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
        />
      </div>

      {isLoading && <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />}
      {!isLoading && (!products || products.length === 0) && <EmptyState icon={Package} title="No products yet" description="Add products to your catalog to enable order matching and inventory tracking." />}

      {!isLoading && products && products.length > 0 && (
        <div className="space-y-2">
          {products.map((product) => {
            const isLow = product.reorderThreshold > 0 && product.stockQuantity <= product.reorderThreshold;
            return (
              <div key={product.id} className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">{product.name}</span>
                    {isLow && <AlertTriangle className="h-4 w-4 text-[var(--color-warning)]" />}
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)]">{product.unit} {formatCurrency(product.price)} {product.aliases.length > 0 && `(${product.aliases.slice(0, 3).join(', ')})`}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`font-mono text-sm ${isLow ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'}`}>
                    {product.stockQuantity} in stock
                  </span>
                  <button onClick={() => adjustStock.mutate({ id: product.id, data: { quantity: 1, type: 'RESTOCK' } })} className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-1.5 hover:bg-[var(--color-surface-hover)]">
                    <Plus className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
                  </button>
                  <button onClick={() => adjustStock.mutate({ id: product.id, data: { quantity: -1, type: 'ADJUSTMENT' } })} className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-1.5 hover:bg-[var(--color-surface-hover)]">
                    <Minus className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
                  </button>
                  <button onClick={() => startEdit(product)} className="text-xs text-[var(--color-primary-light)] hover:underline">Edit</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
