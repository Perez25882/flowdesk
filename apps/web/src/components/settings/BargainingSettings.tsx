import { useEffect, useState } from 'react';
import { Handshake } from 'lucide-react';
import { useBusiness, useUpdateBusiness } from '@/hooks/useBusiness';
import { useProducts } from '@/hooks/useProducts';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { formatCurrency } from '@/lib/utils';

/**
 * The shop-wide switch for haggling.
 *
 * Off by default, and it stays that way until an owner has understood what it
 * does. What makes that understanding possible is the list underneath: turning
 * this on is meaningless in itself, and the only question that matters is
 * "which of my products can now be discounted, and how far". Showing that
 * answer here, rather than making them open twenty product forms to find it , 
 * is the difference between a setting and a liability.
 */
export default function BargainingSettings(): React.JSX.Element {
  const { data: business } = useBusiness();
  const { data: products } = useProducts();
  const updateBusiness = useUpdateBusiness();

  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (business) setEnabled(business.bargainingEnabled ?? false);
  }, [business]);

  const negotiable = (products ?? [])
    .filter((product) => product.active && typeof product.floorPrice === 'number')
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Panel>
      <PanelHead
        title="Haggling"
        meta={enabled ? `${negotiable.length} product${negotiable.length === 1 ? '' : 's'}` : 'Off'}
      />

      <div className="flex flex-col gap-4 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              updateBusiness.mutate({ bargainingEnabled: e.target.checked });
            }}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-primary"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
              <Handshake className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Let Flowdesk negotiate on your behalf
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">
              &ldquo;Last price?&rdquo; is how most people buy, and an assistant that
              cannot answer it sends every sale to you. With this on, Flowdesk haggles
              down to the lowest price you set on each product and never a pesewa
              further. A product with no lowest price set is not discounted at all.
            </span>
          </span>
        </label>

        {enabled && (
          <div className="rounded-md border border-border-subtle">
            {negotiable.length === 0 ? (
              <p className="p-3 text-sm text-text-muted">
                No product has a lowest price yet, so nothing can be discounted. Open a
                product and set one under &ldquo;Sale price, bulk pricing and
                haggling&rdquo;.
              </p>
            ) : (
              <>
                <p className="border-b border-border-subtle px-3 py-2 text-xs text-text-muted">
                  Flowdesk can agree these prices without asking you.
                </p>
                <ul className="divide-y divide-border-subtle">
                  {negotiable.map((product) => (
                    <li key={product.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                        {product.name}
                      </span>
                      <span className="fd-figure shrink-0 text-xs text-text-muted line-through">
                        {formatCurrency(Number(product.price))}
                      </span>
                      <span className="fd-figure shrink-0 text-sm font-medium text-text-primary">
                        {formatCurrency(Number(product.floorPrice))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
