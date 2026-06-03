import { useState } from 'react';
import { Plus, Trash2, ShoppingBag } from 'lucide-react';
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
import { formatCurrency } from '@/lib/utils';

interface OrderItemRow {
  id: string;
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  isFreeText: boolean;
}

const mockProducts = [
  { id: 'p1', name: 'Rice 50kg', price: 450 },
  { id: 'p2', name: 'Vegetable Oil 5L', price: 85 },
  { id: 'p3', name: 'Milo 400g', price: 32 },
  { id: 'p4', name: 'Sugar 1kg', price: 18 },
];

export default function ManualOrderModal(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const createOrder = useCreateOrder();
  const [customerId, setCustomerId] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [notes, setNotes] = useState('');

  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

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
          const product = mockProducts.find((p) => p.id === patch.productId);
          if (product) {
            updated.description = product.name;
            updated.unitPrice = product.price;
          }
        }
        return updated;
      }),
    );
  };

  const removeItem = (id: string): void => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleSubmit = (): void => {
    const data: CreateOrderInput = {
      customerId: customerId || newCustomerPhone,
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
    if (notes) data.notes = notes;
    createOrder.mutate(data, {
      onSuccess: () => {
        setOpen(false);
        setItems([]);
        setCustomerId('');
        setNewCustomerPhone('');
        setNotes('');
      },
    });
  };

  const isNewCustomer = !customerId;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
            >
              <option value="">New customer</option>
              <option value="c1">Kwame Mensah (233244123456)</option>
              <option value="c2">Ama Boateng (233244987654)</option>
            </select>
            {isNewCustomer && (
              <input
                type="tel"
                value={newCustomerPhone}
                onChange={(e) => setNewCustomerPhone(e.target.value)}
                placeholder="Phone number (233XXXXXXXXX)"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
              />
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
                      value={item.productId}
                      onChange={(e) => updateItem(item.id, { productId: e.target.value })}
                      className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                    >
                      <option value="">Select product</option>
                      {mockProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {formatCurrency(p.price)}
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
            disabled={items.length === 0 || createOrder.isPending}
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
