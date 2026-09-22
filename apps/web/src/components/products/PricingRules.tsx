import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/utils';

/**
 * What this product may be sold for.
 *
 * Collapsed behind a disclosure rather than sitting in the main form, because
 * the overwhelming majority of products have one price and an owner adding
 * their twentieth item should not have to scroll past four fields they will
 * never use.
 *
 * The preview line at the bottom is the important part of this component. An
 * owner setting "20% off" and "10+ gets 12% off" and a floor of GHS 70 has no
 * way to hold the resulting arithmetic in their head, and the number that
 * matters, the least this item can now leave the shop for, is the one they
 * would otherwise discover from a settlement report.
 */

export interface PricingForm {
  floorPrice: string;
  discountPercent: string;
  discountLabel: string;
  discountEndsAt: string;
  tiers: Array<{ minQuantity: string; percentOff: string }>;
}

export const EMPTY_PRICING: PricingForm = {
  floorPrice: '',
  discountPercent: '',
  discountLabel: '',
  discountEndsAt: '',
  tiers: [],
};

/** Mirrors the server's rounding: down to the pesewa, never up. */
function applyPercent(price: number, percent: number): number {
  return Math.floor(price * (1 - percent / 100) * 100 + 1e-6) / 100;
}

export function pricingToPayload(pricing: PricingForm): {
  floorPrice: number | null;
  discountPercent: number | null;
  discountLabel: string | null;
  discountEndsAt: string | null;
  tiers: Array<{ minQuantity: number; percentOff: number }>;
} {
  const floor = Number(pricing.floorPrice);
  const percent = Number(pricing.discountPercent);

  return {
    floorPrice: pricing.floorPrice.trim() && floor > 0 ? floor : null,
    discountPercent: pricing.discountPercent.trim() && percent > 0 ? percent : null,
    discountLabel: pricing.discountLabel.trim() || null,
    // A date input gives `YYYY-MM-DD`. Sent as the end of that day so a
    // promotion the owner set to end "on the 20th" runs through the 20th,
    // which is what those words mean to everyone who is not a programmer.
    discountEndsAt: pricing.discountEndsAt.trim()
      ? new Date(`${pricing.discountEndsAt}T23:59:59.000Z`).toISOString()
      : null,
    tiers: pricing.tiers
      .filter((t) => Number(t.minQuantity) >= 2 && Number(t.percentOff) >= 1)
      .map((t) => ({ minQuantity: Number(t.minQuantity), percentOff: Number(t.percentOff) })),
  };
}

export default function PricingRules({
  price,
  unit,
  value,
  onChange,
  bargainingEnabled,
}: {
  /** The list price as typed in the form above, so the preview updates live. */
  price: string;
  unit: string;
  value: PricingForm;
  onChange: (next: PricingForm) => void;
  /** The shop-wide switch. Off means the floor is stored but does nothing. */
  bargainingEnabled: boolean;
}): React.JSX.Element {
  const listPrice = Number(price) || 0;
  const percent = Number(value.discountPercent) || 0;
  const promoPrice = percent > 0 ? applyPercent(listPrice, percent) : listPrice;

  const tierPrices = value.tiers
    .filter((t) => Number(t.minQuantity) >= 2 && Number(t.percentOff) >= 1)
    .map((t) => ({
      minQuantity: Number(t.minQuantity),
      unitPrice: applyPercent(promoPrice, Number(t.percentOff)),
    }))
    .sort((a, b) => a.minQuantity - b.minQuantity);

  const statedFloor = Number(value.floorPrice) || 0;
  const effectiveFloor =
    bargainingEnabled && statedFloor > 0
      ? Math.min(statedFloor, promoPrice, ...tierPrices.map((t) => t.unitPrice))
      : null;

  const floorAboveList = statedFloor > 0 && listPrice > 0 && statedFloor > listPrice;

  function setTier(index: number, patch: Partial<{ minQuantity: string; percentOff: string }>): void {
    const tiers = value.tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier));
    onChange({ ...value, tiers });
  }

  return (
    <details className="lg:col-span-3 rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-text-primary">
        Sale price, bulk pricing and haggling
        <span className="ml-2 text-xs font-normal text-text-muted">optional</span>
      </summary>

      <div className="flex flex-col gap-4 border-t border-border-subtle p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">On sale, % off</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              value={value.discountPercent}
              onChange={(e) => onChange({ ...value, discountPercent: e.target.value })}
              placeholder="20"
              className="fd-input fd-input-compact h-11 py-0 sm:h-10"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">Call it</span>
            <input
              value={value.discountLabel}
              onChange={(e) => onChange({ ...value, discountLabel: e.target.value })}
              placeholder="Flash Sale"
              maxLength={40}
              className="fd-input fd-input-compact h-11 py-0 sm:h-10"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">Until</span>
            <input
              type="date"
              value={value.discountEndsAt}
              onChange={(e) => onChange({ ...value, discountEndsAt: e.target.value })}
              className="fd-input fd-input-compact h-11 py-0 sm:h-10"
            />
            <span className="text-xs text-text-muted">Leave empty to run until you stop it.</span>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-text-primary">Buy more, pay less</span>

          {value.tiers.map((tier, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={2}
                value={tier.minQuantity}
                onChange={(e) => setTier(index, { minQuantity: e.target.value })}
                placeholder="5"
                aria-label="From this many"
                className="fd-input fd-input-compact h-11 w-20 py-0 sm:h-10"
              />
              <span className="text-sm text-text-muted">or more,</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={90}
                value={tier.percentOff}
                onChange={(e) => setTier(index, { percentOff: e.target.value })}
                placeholder="10"
                aria-label="Percent off"
                className="fd-input fd-input-compact h-11 w-20 py-0 sm:h-10"
              />
              <span className="text-sm text-text-muted">% off</span>
              <button
                type="button"
                onClick={() => onChange({ ...value, tiers: value.tiers.filter((_, i) => i !== index) })}
                aria-label={`Remove the ${tier.minQuantity || 'new'}+ bulk price`}
                className="ml-auto rounded-md p-2 text-text-muted hover:bg-surface-hover hover:text-danger"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
          ))}

          {value.tiers.length < 5 && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() =>
                onChange({ ...value, tiers: [...value.tiers, { minQuantity: '', percentOff: '' }] })
              }
              leadingIcon={<Plus className="h-4 w-4" strokeWidth={2} />}
            >
              Add a bulk price
            </Button>
          )}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-primary">
            Lowest you will accept if a customer haggles
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={value.floorPrice}
            onChange={(e) => onChange({ ...value, floorPrice: e.target.value })}
            placeholder="70.00"
            aria-invalid={floorAboveList}
            className="fd-input fd-input-compact h-11 py-0 sm:h-10"
          />
          {floorAboveList ? (
            <span className="text-xs text-danger">
              That is above the normal price. The lowest price has to be less than{' '}
              {formatCurrency(listPrice)}.
            </span>
          ) : (
            <span className="text-xs text-text-muted">
              Leave empty and Flowdesk will never discount this item. It will ask you instead.
            </span>
          )}
        </label>

        {/*
          The one number an owner actually needs to see. Everything above is an
          input; this is the consequence.
        */}
        {listPrice > 0 && (
          <div className="rounded-md bg-surface-sunken p-3 text-sm">
            <p className="text-text-secondary">
              Normally <span className="fd-figure font-medium text-text-primary">{formatCurrency(listPrice)}</span> per {unit || 'unit'}
              {percent > 0 && (
                <>
                  , {percent}% off now so{' '}
                  <span className="fd-figure font-medium text-text-primary">{formatCurrency(promoPrice)}</span>
                </>
              )}
              .
            </p>

            {tierPrices.map((tier) => (
              <p key={tier.minQuantity} className="text-text-secondary">
                {tier.minQuantity} or more:{' '}
                <span className="fd-figure font-medium text-text-primary">{formatCurrency(tier.unitPrice)}</span> each.
              </p>
            ))}

            {effectiveFloor !== null && (
              <p className="mt-1 font-medium text-text-primary">
                Flowdesk will not go below{' '}
                <span className="fd-figure">{formatCurrency(effectiveFloor)}</span>.
              </p>
            )}

            {statedFloor > 0 && !bargainingEnabled && (
              <p className="mt-1 text-warning">
                Haggling is switched off for the whole shop, so this is saved but does nothing.
                Turn it on in Settings.
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
