import { useState } from 'react';
import {
  AI_ASSIST_MODES,
  AI_ASSIST_MODE_LABELS,
  AI_ASSIST_MODE_DESCRIPTIONS,
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  DAYS_OF_WEEK,
  DAY_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PRICING_STANCES,
  PRICING_STANCE_LABELS,
  countAnsweredQuestions,
  PROFILE_QUESTIONS,
  type AiAssistMode,
  type CatalogueMode,
  type BusinessProfile,
  type BusinessType,
  type DayOfWeek,
  type PaymentMethod,
  type PricingStance,
} from '@flowdesk/shared';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { cn } from '@/lib/utils';
import AutonomyConsent from './AutonomyConsent';
import DeliveryZones from './DeliveryZones';

/**
 * What the shop is, and how it runs.
 *
 * This is the only place the assistant learns anything it cannot read out of
 * the order book. Without it, "do you deliver to Tema?" can only ever be
 * answered with "please share more details", which is the behaviour this whole
 * feature exists to remove.
 *
 * Every question is skippable on purpose. A half-filled profile still helps: the
 * assistant answers what it knows and hands the rest to the owner, rather than
 * guessing.
 */

interface Props {
  businessType: BusinessType | null;
  businessTypeOther: string | null;
  profile: BusinessProfile | null;
  policyNotes: string | null;
  assistMode: AiAssistMode;
  /** Whether autonomous replies have been accepted. Gates the AUTONOMOUS option. */
  autonomyAccepted: boolean;
  catalogueMode: CatalogueMode;
  onChange: (patch: {
    businessType?: BusinessType | null;
    businessTypeOther?: string | null;
    businessProfile?: BusinessProfile;
    businessPolicyNotes?: string | null;
    aiAssistMode?: AiAssistMode;
    catalogueMode?: CatalogueMode;
  }) => void;
}

function FieldShell({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="border-b border-border-subtle p-4 last:border-b-0">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-text-primary">
        {label}
      </label>
      {hint && <p className="mb-2 mt-0.5 max-w-prose text-xs text-text-muted">{hint}</p>}
      <div className={cn(hint ? '' : 'mt-2')}>{children}</div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** A toggle chip. Used for days and payment methods, which are both multi-select. */
function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        selected
          ? 'border-primary-border bg-primary-muted text-primary'
          : 'border-border bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

/** Parses a money input. Empty means "no answer"; anything unparseable is ignored. */
function toAmount(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export default function BusinessProfileForm({
  businessType,
  businessTypeOther,
  profile,
  policyNotes,
  assistMode,
  autonomyAccepted,
  catalogueMode,
  onChange,
}: Props): React.JSX.Element {
  const [areaDraft, setAreaDraft] = useState('');

  const hours = profile?.openingHours ?? { days: [], opensAt: null, closesAt: null };
  const areas = profile?.deliveryAreas ?? [];
  const methods = profile?.paymentMethods ?? [];

  /** Sends only the changed keys; the server merges them over what is stored. */
  function patchProfile(patch: Partial<BusinessProfile>): void {
    onChange({ businessProfile: { ...(profile ?? {}), ...patch } });
  }

  function toggleDay(day: DayOfWeek): void {
    const next = hours.days.includes(day)
      ? hours.days.filter((d) => d !== day)
      : [...hours.days, day];
    patchProfile({ openingHours: { ...hours, days: next } });
  }

  function toggleMethod(method: PaymentMethod): void {
    const next = methods.includes(method)
      ? methods.filter((m) => m !== method)
      : [...methods, method];
    patchProfile({ paymentMethods: next });
  }

  function addArea(): void {
    const value = areaDraft.trim();
    if (value === '' || areas.includes(value)) {
      setAreaDraft('');
      return;
    }
    patchProfile({ deliveryAreas: [...areas, value] });
    setAreaDraft('');
  }

  const answered = countAnsweredQuestions(profile);
  const total = PROFILE_QUESTIONS.length;

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <PanelHead
          title="What your business is"
          meta={`${answered} of ${total} answered`}
        />

        <FieldShell
          label="What do you sell?"
          hint="Shapes how messages are read. “Do you have panadol” means something different at a pharmacy than at a hardware shop."
          htmlFor="business-type"
        >
          <select
            id="business-type"
            className={inputClass}
            value={businessType ?? ''}
            onChange={(e) =>
              onChange({ businessType: (e.target.value || null) as BusinessType | null })
            }
          >
            <option value="">Choose one</option>
            {BUSINESS_TYPES.map((type) => (
              <option key={type} value={type}>
                {BUSINESS_TYPE_LABELS[type]}
              </option>
            ))}
          </select>

          {businessType === 'OTHER' && (
            <input
              className={cn(inputClass, 'mt-2')}
              placeholder="Tell us in a few words"
              value={businessTypeOther ?? ''}
              onChange={(e) => onChange({ businessTypeOther: e.target.value || null })}
            />
          )}
        </FieldShell>
      </Panel>

      <Panel>
        <PanelHead title="How you operate" />

        <FieldShell label="When are you open?" hint={PROFILE_QUESTIONS[0]!.hint}>
          <div className="flex flex-wrap gap-1.5">
            {DAYS_OF_WEEK.map((day) => (
              <Chip key={day} selected={hours.days.includes(day)} onClick={() => toggleDay(day)}>
                {DAY_LABELS[day].slice(0, 3)}
              </Chip>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="opens-at" className="text-xs text-text-secondary">
              Open
            </label>
            <input
              id="opens-at"
              type="time"
              className={cn(inputClass, 'w-32')}
              value={hours.opensAt ?? ''}
              onChange={(e) =>
                patchProfile({ openingHours: { ...hours, opensAt: e.target.value || null } })
              }
            />
            <label htmlFor="closes-at" className="text-xs text-text-secondary">
              Close
            </label>
            <input
              id="closes-at"
              type="time"
              className={cn(inputClass, 'w-32')}
              value={hours.closesAt ?? ''}
              onChange={(e) =>
                patchProfile({ openingHours: { ...hours, closesAt: e.target.value || null } })
              }
            />
          </div>
        </FieldShell>

        <FieldShell label="Where do you deliver?" hint={PROFILE_QUESTIONS[1]!.hint}>
          {areas.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {areas.map((area) => (
                <span
                  key={area}
                  className="flex items-center gap-1 rounded-full border border-border bg-surface-sunken px-2.5 py-1 text-xs text-text-primary"
                >
                  {area}
                  <button
                    type="button"
                    aria-label={`Remove ${area}`}
                    onClick={() =>
                      patchProfile({ deliveryAreas: areas.filter((a) => a !== area) })
                    }
                    className="text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              className={inputClass}
              placeholder="Add an area, e.g. Tema"
              value={areaDraft}
              onChange={(e) => setAreaDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addArea();
                }
              }}
            />
            <button
              type="button"
              onClick={addArea}
              className="rounded-md border border-border px-3 text-sm text-text-secondary hover:border-border-strong hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Add
            </button>
          </div>
          <p className="mt-1.5 text-xs text-text-muted">
            Leave empty if you do not deliver. Customers get told that plainly.
          </p>
        </FieldShell>

        <FieldShell
          label="Delivery charges by place"
          hint="One flat fee overcharges the customer nearby and loses money on the far one."
        >
          <DeliveryZones
            zones={profile?.deliveryZones ?? []}
            onChange={(deliveryZones) => patchProfile({ deliveryZones })}
          />
        </FieldShell>

        <FieldShell
          label="Charge for anywhere else"
          hint="Used only for a place not on the list above. Leave empty to have the assistant ask you instead."
          htmlFor="delivery-fee"
        >
          <div className="flex items-center gap-2">
            <span className="fd-figure text-sm text-text-secondary">GHS</span>
            <input
              id="delivery-fee"
              inputMode="decimal"
              className={cn(inputClass, 'w-32')}
              placeholder="0.00"
              value={profile?.deliveryFee ?? ''}
              onChange={(e) => {
                const value = toAmount(e.target.value);
                if (value !== undefined) patchProfile({ deliveryFee: value });
              }}
            />
          </div>
        </FieldShell>

        <FieldShell
          label="Where is the shop?"
          hint="A map link or GhanaPost code, sent automatically to anyone who asks where to find you."
          htmlFor="location-url"
        >
          <div className="flex flex-col gap-2">
            <input
              id="location-url"
              className={inputClass}
              placeholder="https://maps.app.goo.gl/… or GA-123-4567"
              value={profile?.locationUrl ?? ''}
              onChange={(e) => patchProfile({ locationUrl: e.target.value.trim() || null })}
            />
            <input
              aria-label="How to find the shop, in words"
              className={inputClass}
              placeholder="Behind Melcom, Spintex Road"
              value={profile?.locationDescription ?? ''}
              onChange={(e) =>
                patchProfile({ locationDescription: e.target.value || null })
              }
            />
          </div>
        </FieldShell>

        <FieldShell
          label="Free delivery above"
          hint={PROFILE_QUESTIONS[3]!.hint}
          htmlFor="free-above"
        >
          <div className="flex items-center gap-2">
            <span className="fd-figure text-sm text-text-secondary">GHS</span>
            <input
              id="free-above"
              inputMode="decimal"
              className={cn(inputClass, 'w-32')}
              placeholder="No threshold"
              value={profile?.freeDeliveryAbove ?? ''}
              onChange={(e) => {
                const value = toAmount(e.target.value);
                if (value !== undefined) patchProfile({ freeDeliveryAbove: value });
              }}
            />
          </div>
        </FieldShell>

        <FieldShell
          label="Minimum order"
          hint={PROFILE_QUESTIONS[4]!.hint}
          htmlFor="minimum-order"
        >
          <div className="flex items-center gap-2">
            <span className="fd-figure text-sm text-text-secondary">GHS</span>
            <input
              id="minimum-order"
              inputMode="decimal"
              className={cn(inputClass, 'w-32')}
              placeholder="No minimum"
              value={profile?.minimumOrder ?? ''}
              onChange={(e) => {
                const value = toAmount(e.target.value);
                if (value !== undefined) patchProfile({ minimumOrder: value });
              }}
            />
          </div>
        </FieldShell>

        <FieldShell label="How can customers pay?" hint={PROFILE_QUESTIONS[5]!.hint}>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_METHODS.map((method) => (
              <Chip
                key={method}
                selected={methods.includes(method)}
                onClick={() => toggleMethod(method)}
              >
                {PAYMENT_METHOD_LABELS[method]}
              </Chip>
            ))}
          </div>
        </FieldShell>

        <FieldShell
          label="Can customers negotiate?"
          hint={PROFILE_QUESTIONS[6]!.hint}
          htmlFor="pricing-stance"
        >
          <select
            id="pricing-stance"
            className={inputClass}
            value={profile?.pricingStance ?? ''}
            onChange={(e) =>
              patchProfile({ pricingStance: (e.target.value || undefined) as PricingStance })
            }
          >
            <option value="">Not set</option>
            {PRICING_STANCES.map((stance) => (
              <option key={stance} value={stance}>
                {PRICING_STANCE_LABELS[stance]}
              </option>
            ))}
          </select>
        </FieldShell>

        <FieldShell label="Do you accept returns?" hint={PROFILE_QUESTIONS[7]!.hint}>
          <div className="flex flex-wrap items-center gap-2">
            <Chip
              selected={profile?.acceptsReturns === true}
              onClick={() => patchProfile({ acceptsReturns: true })}
            >
              Yes
            </Chip>
            <Chip
              selected={profile?.acceptsReturns === false}
              onClick={() => patchProfile({ acceptsReturns: false, returnWindowDays: null })}
            >
              No
            </Chip>

            {profile?.acceptsReturns === true && (
              <span className="flex items-center gap-2">
                <label htmlFor="return-days" className="text-xs text-text-secondary">
                  Within
                </label>
                <input
                  id="return-days"
                  inputMode="numeric"
                  className={cn(inputClass, 'w-20')}
                  placeholder="7"
                  value={profile.returnWindowDays ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === '') {
                      patchProfile({ returnWindowDays: null });
                      return;
                    }
                    const days = Number(raw);
                    if (Number.isInteger(days) && days >= 0) {
                      patchProfile({ returnWindowDays: days });
                    }
                  }}
                />
                <span className="text-xs text-text-secondary">days</span>
              </span>
            )}
          </div>
        </FieldShell>
      </Panel>

      <Panel>
        <PanelHead title="Anything else" />

        <FieldShell
          label="Notes for the assistant"
          hint="Anything unusual about how you work. Used to help write a reply for you to check, never to answer a customer on its own, because wording like this cannot be verified."
          htmlFor="policy-notes"
        >
          <textarea
            id="policy-notes"
            rows={4}
            className={cn(inputClass, 'resize-y')}
            placeholder="e.g. We close early on the last Friday of the month."
            value={policyNotes ?? ''}
            onChange={(e) => onChange({ businessPolicyNotes: e.target.value || null })}
          />
        </FieldShell>

        <FieldShell
          label="Do you keep a product list here?"
          hint="Plenty of shops do not, and never need to. If your stock changes daily or every piece is different, choose the second option. The assistant will stop guessing at prices and start asking you instead."
          htmlFor="catalogue-mode"
        >
          <select
            id="catalogue-mode"
            className={inputClass}
            value={catalogueMode}
            onChange={(e) => onChange({ catalogueMode: e.target.value as CatalogueMode })}
          >
            <option value="CATALOGUE">
              Yes, I add my products and prices in Flowdesk
            </option>
            <option value="ENQUIRY_LED">
              No, customers ask and I tell them what I have
            </option>
          </select>

          {catalogueMode === 'ENQUIRY_LED' && (
            <p className="mt-2 border-l-2 border-border-strong pl-3 text-sm text-text-secondary">
              When someone asks for something, the assistant replies to hold them
              &ldquo;let me check on baggy jeans for you&rdquo;, and puts the question in
              front of you. It will never tell a customer you have something, or
              that you do not, because only you know.
            </p>
          )}
        </FieldShell>

        <FieldShell
          label="How much should the assistant do?"
          hint="You can change this at any time."
          htmlFor="assist-mode"
        >
          <div className="flex flex-col gap-3">
            <select
              id="assist-mode"
              className={inputClass}
              value={assistMode}
              onChange={(e) => {
                const next = e.target.value as AiAssistMode;
                // Autonomous cannot be selected until it has been accepted, and
                // the API refuses it anyway, so the select does not pretend
                // otherwise and quietly fail on save.
                if (next === 'AUTONOMOUS' && !autonomyAccepted) return;
                onChange({ aiAssistMode: next });
              }}
            >
              {AI_ASSIST_MODES.map((mode) => (
                <option
                  key={mode}
                  value={mode}
                  disabled={mode === 'AUTONOMOUS' && !autonomyAccepted}
                >
                  {AI_ASSIST_MODE_LABELS[mode]}
                  {mode === 'AUTONOMOUS' && !autonomyAccepted ? ', needs accepting first' : ''}
                </option>
              ))}
            </select>

            <p className="max-w-prose text-xs text-text-muted">
              {AI_ASSIST_MODE_DESCRIPTIONS[assistMode]}
            </p>

            {/* Shown whenever autonomy is in play, either to accept it, or to
                confirm and withdraw an acceptance already on file. */}
            {(assistMode === 'AUTONOMOUS' || !autonomyAccepted) && (
              <AutonomyConsent
                accepted={autonomyAccepted}
                onAccepted={() => onChange({})}
              />
            )}
          </div>
        </FieldShell>
      </Panel>
    </div>
  );
}
