import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { useBusiness, useUpdateBusiness } from '@/hooks/useBusiness';
import { useServices } from '@/hooks/useBookings';
import { Panel, PanelHead } from '@/components/ui/Panel';

/**
 * The switch that gives a business a diary.
 *
 * Off by default, and the copy is doing real work here: an owner who turns
 * this on without opening hours set gets a diary that can never offer a time,
 * and the failure looks like the feature is broken rather than like a field is
 * empty. So the dependency is stated at the moment of the decision instead of
 * being discovered later from an assistant that will not book anything.
 */
export default function BookingSettings(): React.JSX.Element {
  const { data: business } = useBusiness();
  const { data: services } = useServices();
  const updateBusiness = useUpdateBusiness();

  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (business) setEnabled(business.bookingsEnabled ?? false);
  }, [business]);

  const hasHours = Boolean(
    business?.businessProfile?.openingHours?.days?.length &&
      business.businessProfile.openingHours.opensAt &&
      business.businessProfile.openingHours.closesAt,
  );

  return (
    <Panel>
      <PanelHead
        title="Appointments"
        meta={enabled ? `${services?.length ?? 0} service${(services?.length ?? 0) === 1 ? '' : 's'}` : 'Off'}
      />

      <div className="flex flex-col gap-4 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              updateBusiness.mutate({ bookingsEnabled: e.target.checked });
            }}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-primary"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
              <CalendarClock className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Take appointments on WhatsApp
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">
              For anything sold by the hour rather than off a shelf: a consultation, a
              class, a fitting, a site visit. Flowdesk offers only times that are genuinely
              free and will not put two people in the same slot.
            </span>
          </span>
        </label>

        {enabled && !hasHours && (
          <p className="rounded-md bg-warning-muted p-3 text-sm text-text-secondary">
            No opening hours are set, so there are no times to offer and nothing can be
            booked. Add them under Assistant &rarr; when you are open, and the diary starts
            working immediately.
          </p>
        )}

        {enabled && hasHours && (services?.length ?? 0) === 0 && (
          <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-secondary">
            Next: add what you offer, on the Bookings page. Until there is at least one
            service there is nothing for a customer to book.
          </p>
        )}
      </div>
    </Panel>
  );
}
