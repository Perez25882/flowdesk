import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { GHANA_REGIONS, type DeliveryZone, type GhanaRegion } from '@flowdesk/shared';
import { cn, formatCurrency } from '@/lib/utils';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** Where most of these shops are, so the common case is one tap fewer. */
const DEFAULT_REGION: GhanaRegion = 'Greater Accra';

interface ZoneDraft {
  region: GhanaRegion;
  town: string;
  area: string;
  fee: string;
  eta: string;
}

const EMPTY_DRAFT: ZoneDraft = {
  region: DEFAULT_REGION,
  town: '',
  area: '',
  fee: '',
  eta: '',
};

/**
 * Delivery prices, by place.
 *
 * Replaces the single flat fee, which was wrong in both directions at once: a
 * shop charging GHS 20 across Accra overcharges the customer two streets away
 * and loses money on the one in Kasoa. The owner's real answer to "how much to
 * bring it?" has always depended on where, and this is the first version that
 * lets them write that down.
 *
 * The area field is optional on purpose. Plenty of shops price by town and no
 * further, and forcing a neighbourhood out of them would produce invented ones.
 */
export default function DeliveryZones({
  zones,
  onChange,
}: {
  zones: DeliveryZone[];
  onChange: (zones: DeliveryZone[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<ZoneDraft>(EMPTY_DRAFT);

  const fee = Number.parseFloat(draft.fee);
  const canAdd = draft.town.trim().length > 0 && Number.isFinite(fee) && fee >= 0;

  function add(): void {
    if (!canAdd) return;
    onChange([
      ...zones,
      {
        region: draft.region,
        town: draft.town.trim(),
        area: draft.area.trim() || null,
        fee,
        eta: draft.eta.trim() || null,
      },
    ]);
    // Region and town are kept: an owner adding zones is almost always adding
    // several areas of the same town, and clearing them would mean retyping
    // "Tema" five times.
    setDraft({ ...EMPTY_DRAFT, region: draft.region, town: draft.town });
  }

  return (
    <div className="flex flex-col gap-3">
      {zones.length > 0 && (
        <ul className="divide-y divide-border-subtle rounded-md border border-border">
          {zones.map((zone, index) => (
            <li
              key={`${zone.region}-${zone.town}-${zone.area ?? ''}-${index}`}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text-primary">
                  {zone.area ? `${zone.town} · ${zone.area}` : zone.town}
                </span>
                <span className="text-xs text-text-muted">
                  {zone.region}
                  {zone.eta ? ` · ${zone.eta}` : ''}
                </span>
              </span>

              <span className="fd-figure shrink-0 text-sm font-medium text-text-primary">
                {zone.fee === 0 ? 'Free' : formatCurrency(zone.fee)}
              </span>

              <button
                type="button"
                onClick={() => onChange(zones.filter((_, i) => i !== index))}
                aria-label={`Remove delivery to ${zone.area ?? zone.town}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-12">
        <select
          aria-label="Region"
          value={draft.region}
          onChange={(e) => setDraft({ ...draft, region: e.target.value as GhanaRegion })}
          className={cn(inputClass, 'sm:col-span-3')}
        >
          {GHANA_REGIONS.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>

        <input
          aria-label="Town"
          value={draft.town}
          onChange={(e) => setDraft({ ...draft, town: e.target.value })}
          placeholder="Town, e.g. Tema"
          className={cn(inputClass, 'sm:col-span-3')}
        />

        <input
          aria-label="Area, if you price by area"
          value={draft.area}
          onChange={(e) => setDraft({ ...draft, area: e.target.value })}
          placeholder="Area (optional)"
          className={cn(inputClass, 'sm:col-span-2')}
        />

        <input
          aria-label="Delivery charge in cedis"
          inputMode="decimal"
          value={draft.fee}
          onChange={(e) => setDraft({ ...draft, fee: e.target.value })}
          placeholder="GHS"
          className={cn(inputClass, 'sm:col-span-2')}
        />

        <input
          aria-label="How long it takes"
          value={draft.eta}
          onChange={(e) => setDraft({ ...draft, eta: e.target.value })}
          placeholder="Same day"
          className={cn(inputClass, 'sm:col-span-2')}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={add}
          disabled={!canAdd}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Add this place
        </button>
      </div>

      <p className="text-xs text-text-muted">
        A place that is not on this list is never guessed at. The assistant says it will
        check and hands it to you.
      </p>
    </div>
  );
}
