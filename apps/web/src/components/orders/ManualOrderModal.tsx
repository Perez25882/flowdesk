import { useMemo, useState } from 'react';
import { Plus, Trash2, ShoppingBag, Search } from 'lucide-react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import type { CreateOrderInput } from '@/types/order';
import { useCreateOrder } from '@/hooks/useOrders';
import { useProducts } from '@/hooks/useProducts';
import { useCustomers } from '@/hooks/useCustomers';
import { formatCurrency } from '@/lib/utils';

interface OrderItemRow {
  id: string;
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  isFreeText: boolean;
}

function normalizeGhanaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) return `233${digits.slice(1)}`;
  if (digits.startsWith('233')) return digits;
  return `233${digits}`;
}

export default function ManualOrderModal(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const createOrder = useCreateOrder();
  const [customerId, setCustomerId] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [notes, setNotes] = useState('');

  const { data: products = [] } = useProducts();
  const { data: customers = [] } = useCustomers(customerSearch || undefined);

  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  const activeProducts = useMemo(
    () => products.filter((p) => p.active && Number(p.stockQuantity) > 0),
    [products],
  );

  const addItem = (isFreeText = false): void => {
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        description: '',
        quantity: 1,
        unitPrice: 0,
        isFreeText,
      },
    ]);
  };

  const updateItem = (id: string, patch: Partial<OrderItemRow>): void => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...patch };
        if (patch.productId && !patch.isFreeText) {
          const product = activeProducts.find((p) => p.id === patch.productId);
          if (product) {
            updated.description = product.name;
            updated.unitPrice = Number(product.price);
          }
        }
        return updated;
      }),
    );
  };

  const removeItem = (id: string): void => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const reset = (): void => {
    setItems([]);
    setCustomerId('');
    setNewCustomerPhone('');
    setNewCustomerName('');
    setCustomerSearch('');
    setNotes('');
  };

  const handleSubmit = (): void => {
    if (!customerId && !newCustomerPhone) return;

    const data: CreateOrderInput = {
      rawMessage: notes || 'Manual order',
      items: items.map((i) => {
        const base = {
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        };
        return i.productId ? { ...base, productId: i.productId } : base;
      }),
    };
    if (customerId) {
      data.customerId = customerId;
    } else {
      data.customerPhone = normalizeGhanaPhone(newCustomerPhone);
      if (newCustomerName) data.customerName = newCustomerName;
    }
    if (notes) data.notes = notes;

    createOrder.mutate(data, {
      onSuccess: () => {
        setOpen(false);
        reset();
      },
    });
  };

  const isNewCustomer = !customerId;
  const canSubmit =
    items.length > 0 &&
    !createOrder.isPending &&
    (!!customerId || newCustomerPhone.replace(/\D/g, '').length >= 9);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-light)]">
          <Plus className="h-4 w-4" />
          New Order
       </button>
     </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Manual Order</DialogTitle>
          <DialogDescription>Walk-in or phone order entry</DialogDescription>
       </DialogHeader>

        <div className="space-y-4">
          {/* Customer */}
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Customer
           </label>
            {isNewCustomer ? (
              <>
                <button
                  type="button"
                  onClick={() => setCustomerId('')}
                  className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--color-primary-muted)] px-2 py-1 text-[11px] font-medium text-[var(--color-primary-light)]"
                >
                  New customer
               </button>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    type="tel"
                    value={newCustomerPhone}
                    onChange={(e) => setNewCustomerPhone(e.target.value)}
                    placeholder="Phone (233XXXXXXXXX)"
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <input
                    type="text"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    placeholder="Name (optional)"
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
               </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <input
                      type="text"
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      placeholder="Search by name or phone..."
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                    />
                 </div>
                  <button
                    type="button"
                    onClick={() => setCustomerId('')}
                    className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                  >
                    New
                 </button>
               </div>
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                >
                  <option value="">Pick a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.waNumber} — {c.waNumber}
                   </option>
                  ))}
               </select>
              </>
            )}
         </div>

          {/* Items */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Items
             </label>
              <div className="flex gap-2">
                <button
                  onClick={() => addItem(false)}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  <Plus className="h-3 w-3" /> Catalog
               </button>
                <button
                  onClick={() => addItem(true)}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  <Plus className="h-3 w-3" /> Free text
               </button>
             </div>
           </div>

            <div className="space-y-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-2"
                >
                  {item.isFreeText ? (
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => updateItem(item.id, { description: e.target.value })}
                      placeholder="Item description"
                      className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                    />
                  ) : (
                    <select
                      value={item.productId ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        const patch: Partial<OrderItemRow> = v ? { productId: v } : {};
                        updateItem(item.id, patch);
                      }}
                      className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                    >
                      <option value="">Select product</option>
                      {activeProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {formatCurrency(Number(p.price))}
                       </option>
                      ))}
                   </select>
                  )}
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={item.quantity}
                    onChange={(e) => updateItem(item.id, { quantity: Number.parseFloat(e.target.value) || 0 })}
                    placeholder="Qty"
                    className="w-16 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] text-center focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.id, { unitPrice: Number.parseFloat(e.target.value) || 0 })}
                    placeholder="Price"
                    className="w-20 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <button
                    onClick={() => removeItem(item.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 className="h-4 w-4" />
                 </button>
               </div>
              ))}
              {items.length === 0 && (
                <p className="rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-muted)]">
                  No items yet. Use Catalog or Free text to add the first line.
               </p>
              )}
           </div>
         </div>

          {/* Notes */}
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Notes
           </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional order notes..."
              className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
         </div>

          {/* Total */}
          <div className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-4 py-3">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">Total</span>
            <span className="font-mono text-lg font-semibold text-[var(--color-text-primary)]">
              {formatCurrency(total)}
           </span>
         </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-light)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ShoppingBag className="h-4 w-4" />
            {createOrder.isPending ? 'Creating...' : 'Create Order'}
         </button>
       </div>
     </DialogContent>
   </Dialog>
  );
}
