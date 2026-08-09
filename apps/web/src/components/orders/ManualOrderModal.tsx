import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import type { CreateOrderInput } from '@/types/order';
import { useCreateOrder } from '@/hooks/useOrders';
import { useProducts } from '@/hooks/useProducts';
import { useCustomers } from '@/hooks/useCustomers';
import { Button } from '@/components/ui/Button';
import { formatCurrency, cn } from '@/lib/utils';

/**
 * Manual order entry, for a walk-in or a phone call.
 *
 * Two behavioural fixes came out of the redesign, not just visual ones:
 *
 *   1. The customer picker was unreachable. `isNewCustomer` was derived as
 *      `!customerId`, so the form opened in "new customer" mode and the only
 *      button offered set `customerId` back to `''` — meaning the search box
 *      for existing customers could never be shown. It is now an explicit mode.
 *   2. The submit button sat at the bottom of a scrolling dialog. It is now
 *      pinned, with the running total beside it, so the person entering a
 *      six-line order can always see what they are about to charge.
 */

interface OrderItemRow {
  id: string;
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  isFreeText: boolean;
}

/** Accepts 024…, +233 24…, or 23324… and returns the wire format. */
function normalizeGhanaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) return `233${digits.slice(1)}`;
  if (digits.startsWith('233')) return digits;
  return `233${digits}`;
}

export default function ManualOrderModal(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const createOrder = useCreateOrder();

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
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

  function addItem(isFreeText = false): void {
    setItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), description: '', quantity: 1, unitPrice: 0, isFreeText },
    ]);
  }

  function updateItem(id: string, patch: Partial<OrderItemRow>): void {
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
  }

  function removeItem(id: string): void {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function reset(): void {
    setItems([]);
    setMode('existing');
    setCustomerId('');
    setNewCustomerPhone('');
    setNewCustomerName('');
    setCustomerSearch('');
    setNotes('');
  }

  function handleSubmit(): void {
    const data: CreateOrderInput = {
      rawMessage: notes || 'Entered by hand',
      items: items.map((i) => {
        const base = { description: i.description, quantity: i.quantity, unitPrice: i.unitPrice };
        return i.productId ? { ...base, productId: i.productId } : base;
      }),
    };

    if (mode === 'existing' && customerId) {
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
  }

  const hasCustomer =
    mode === 'existing' ? !!customerId : newCustomerPhone.replace(/\D/g, '').length >= 9;
  const hasCompleteItems = items.length > 0 && items.every((i) => i.description.trim().length > 0);
  const canSubmit = hasCustomer && hasCompleteItems;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" leadingIcon={<Plus className="h-4 w-4" strokeWidth={2} />}>
          New order
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl p-0">
        <DialogHeader>
          <DialogTitle>New order</DialogTitle>
          <DialogDescription>
            For a customer who walked in or called instead of messaging.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6">
          {/* ── Who ── */}
          <section>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <h3 className="fd-label">Customer</h3>

              {/* A two-state switch, so both branches are actually reachable. */}
              <div
                role="radiogroup"
                aria-label="Customer type"
                className="flex rounded-md border border-border p-0.5"
              >
                {(['existing', 'new'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={mode === option}
                    onClick={() => setMode(option)}
                    className={cn(
                      'rounded-xs px-2.5 py-1 text-xs font-medium transition-colors duration-fast ease-out',
                      mode === option
                        ? 'bg-primary-muted text-primary'
                        : 'text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {option === 'existing' ? 'Existing' : 'New'}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'new' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="tel"
                  inputMode="tel"
                  value={newCustomerPhone}
                  onChange={(e) => setNewCustomerPhone(e.target.value)}
                  aria-label="Customer phone number"
                  placeholder="024 418 7702"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
                <input
                  type="text"
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  aria-label="Customer name, optional"
                  placeholder="Name, if you know it"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="search"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  aria-label="Search customers by name or number"
                  placeholder="Search name or number"
                  className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                />
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  aria-label="Choose a customer"
                  className="fd-input fd-select fd-input-compact h-11 py-0 sm:h-10"
                >
                  <option value="">Choose a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name ? `${c.name} — ${c.waNumber}` : c.waNumber}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </section>

          {/* ── What ── */}
          <section>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <h3 className="fd-label">Items</h3>
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => addItem(false)}>
                  From catalogue
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addItem(true)}>
                  Type it out
                </Button>
              </div>
            </div>

            {items.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-4 py-7 text-center text-sm text-text-muted">
                No items yet. Add one from your catalogue, or type it out if it is not listed.
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((item, index) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2">
                    <span className="fd-figure w-4 shrink-0 text-xs text-text-muted">{index + 1}</span>

                    {item.isFreeText ? (
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) => updateItem(item.id, { description: e.target.value })}
                        aria-label={`Item ${index + 1} description`}
                        placeholder="What did they buy?"
                        className="fd-input fd-input-compact h-11 min-w-0 flex-1 basis-[calc(100%-1.5rem)] py-0 sm:h-10 sm:basis-auto"
                      />
                    ) : (
                      <select
                        value={item.productId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateItem(item.id, v ? { productId: v } : {});
                        }}
                        aria-label={`Item ${index + 1} product`}
                        className="fd-input fd-select fd-input-compact h-11 min-w-0 flex-1 basis-[calc(100%-1.5rem)] py-0 sm:h-10 sm:basis-auto"
                      >
                        <option value="">Choose a product</option>
                        {activeProducts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {formatCurrency(Number(p.price))}
                          </option>
                        ))}
                      </select>
                    )}

                    <input
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      step={0.1}
                      value={item.quantity}
                      onChange={(e) =>
                        updateItem(item.id, { quantity: Number.parseFloat(e.target.value) || 0 })
                      }
                      aria-label={`Item ${index + 1} quantity`}
                      className="fd-input fd-input-compact h-11 w-[62px] shrink-0 px-1.5 py-0 text-center sm:h-10 sm:w-[64px] sm:px-2"
                    />

                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      value={item.unitPrice}
                      onChange={(e) =>
                        updateItem(item.id, { unitPrice: Number.parseFloat(e.target.value) || 0 })
                      }
                      aria-label={`Item ${index + 1} unit price in cedis`}
                      className="fd-input fd-input-compact h-11 w-[84px] shrink-0 px-1.5 py-0 text-right sm:h-10 sm:w-[88px] sm:px-2"
                    />

                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      aria-label={`Remove item ${index + 1}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-fast ease-out hover:bg-danger-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:h-10 sm:w-9"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Anything else ── */}
          <section>
            <h3 className="fd-label mb-2.5">Note</h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              aria-label="Note about this order, optional"
              placeholder="Delivery instructions, or anything you want on the record."
              className="fd-input fd-input-compact resize-none"
            />
          </section>

          {createOrder.isError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {(createOrder.error as Error).message}
            </p>
          )}
        </DialogBody>

        {/* The running total lives with the button that commits it. */}
        <DialogFooter className="justify-between">
          <span className="flex items-baseline gap-2">
            <span className="fd-label">Total</span>
            <span className="fd-figure text-lg font-semibold text-text-primary">
              {formatCurrency(total)}
            </span>
          </span>

          <Button onClick={handleSubmit} disabled={!canSubmit} isLoading={createOrder.isPending}>
            Create order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
