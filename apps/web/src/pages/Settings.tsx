import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, RotateCw } from 'lucide-react';
import type { AiAssistMode, BusinessProfile, BusinessType, CatalogueMode } from '@flowdesk/shared';
import {
  useBusiness,
  useReplyTemplates,
  useUpdateBusiness,
  type Business,
  type ReplyTemplateEntry,
  type UpdateBusinessInput,
} from '@/hooks/useBusiness';
import BusinessProfileForm from '@/components/settings/BusinessProfileForm';
import { useBadges } from '@/hooks/useBadges';
import { useCheckout, type BillablePlan } from '@/hooks/useBilling';
import { BILLABLE_PLAN_CODES, PLANS, getPlan, limit, planHighlights } from '@/config/plans';
import WhatsAppConnection from '@/components/settings/WhatsAppConnection';
import PageHeader from '@/components/shared/PageHeader';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, type TabOption } from '@/components/ui/Tabs';
import { useTabParam } from '@/hooks/useTabParam';
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning';
import { cn } from '@/lib/utils';

interface DraftState {
  name: string;
  ownerName: string;
  notifyOnNewOrder: boolean;
  notifyOnLowStock: boolean;
  notifyOnPayment: boolean;
}

/** What the assistant knows about the business, edited as one unit. */
interface AssistantDraft {
  businessType: BusinessType | null;
  businessTypeOther: string | null;
  businessProfile: BusinessProfile;
  businessPolicyNotes: string | null;
  aiAssistMode: AiAssistMode;
  catalogueMode: CatalogueMode;
}

function assistantDraftFrom(business: Business): AssistantDraft {
  return {
    businessType: business.businessType,
    businessTypeOther: business.businessTypeOther,
    businessProfile: business.businessProfile ?? {},
    businessPolicyNotes: business.businessPolicyNotes,
    aiAssistMode: business.aiAssistMode,
    catalogueMode: business.catalogueMode,
  };
}

/**
 * Reply template drafts, keyed by the engine's template keys.
 *
 * The keys, labels, placeholders and default wording all come from
 * `GET /settings/templates` — the reply engine's own catalogue. This page used
 * to hold a hand-copied duplicate of all of it, which had to stay byte-identical
 * to the server's with nothing to catch it when it didn't. The API validates
 * keys against that same list, so drift was not cosmetic: it made every save
 * fail with a 400 and the owner could not customise their replies at all.
 */
type ReplyTemplatesDraft = Record<string, string>;


type SettingsTab = 'business' | 'assistant' | 'replies' | 'plan';

const TAB_OPTIONS: readonly TabOption<SettingsTab>[] = [
  { value: 'business', label: 'Business' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'replies', label: 'Automatic replies' },
  { value: 'plan', label: 'Plan and billing' },
];

const SETTINGS_TAB_VALUES = TAB_OPTIONS.map((t) => t.value);

/**
 * The wording currently in force for each template: the owner's override where
 * they set one, otherwise the engine's default. Both come from the server, so
 * this page has no opinion about what any reply says.
 */
function templatesFromCatalogue(entries: ReplyTemplateEntry[] | undefined): ReplyTemplatesDraft {
  const out: ReplyTemplatesDraft = {};
  for (const entry of entries ?? []) {
    out[entry.key] = entry.text ?? entry.defaultText;
  }
  return out;
}

/** Every template back to the shipped wording, discarding all customisation. */
function resetAllToDefaults(entries: ReplyTemplateEntry[] | undefined): ReplyTemplatesDraft {
  const out: ReplyTemplatesDraft = {};
  for (const entry of entries ?? []) {
    out[entry.key] = entry.defaultText;
  }
  return out;
}

/**
 * Settings.
 *
 * This was one 600-line scroll ending in a Save button. Two consequences: the
 * button was invisible from anywhere you might actually make a change, and the
 * twelve reply templates — the longest and least frequently touched section —
 * sat between the owner and everything else.
 *
 * It is now three sections, with a save bar that appears only when something is
 * unsaved and then stays pinned to the bottom of the viewport. The bar also
 * says how many changes are pending, because on a page this size it is easy to
 * forget you edited something two sections ago.
 */
export default function SettingsPage(): React.JSX.Element {
  const { data: business, isLoading, refetch: refetchBusiness } = useBusiness();
  const { data: templateCatalogue } = useReplyTemplates();
  const updateBusiness = useUpdateBusiness();
  const { data: badges } = useBadges();
  const checkout = useCheckout();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useTabParam<SettingsTab>('section', SETTINGS_TAB_VALUES, 'business');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [draftTemplates, setDraftTemplates] = useState<ReplyTemplatesDraft>({});
  const [draftAssistant, setDraftAssistant] = useState<AssistantDraft | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Detect a Paystack return. ?billing=return means the user bounced back from
  // the hosted checkout — refetch so they immediately see the upgraded plan.
  // ?billing=cancelled means they bailed before paying.
  const billingReturn = searchParams.get('billing') === 'return';
  const billingCancelled = searchParams.get('billing') === 'cancelled';
  const wantsWhatsAppSetup = searchParams.get('connect') === 'whatsapp';

  useEffect(() => {
    if (!billingReturn && !billingCancelled) return;
    void refetchBusiness();
    // Strip the marker so a refresh does not re-trigger.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('billing');
        return next;
      },
      { replace: true },
    );
  }, [billingReturn, billingCancelled, refetchBusiness, setSearchParams]);

  useEffect(() => {
    if (business && !draft) {
      setDraft({
        name: business.name,
        ownerName: business.ownerName,
        notifyOnNewOrder: business.notifyOnNewOrder,
        notifyOnLowStock: business.notifyOnLowStock,
        notifyOnPayment: business.notifyOnPayment,
      });
      setDraftAssistant(assistantDraftFrom(business));
    }
  }, [business, draft]);

  // Template drafts hydrate from the catalogue, which arrives on its own request.
  useEffect(() => {
    if (templateCatalogue) {
      setDraftTemplates(templatesFromCatalogue(templateCatalogue));
    }
  }, [templateCatalogue]);

  function handleUpgrade(plan: BillablePlan): void {
    checkout.mutate(plan, {
      onSuccess: (data) => {
        window.location.href = data.authorizationUrl;
      },
    });
  }

  const profileDirty =
    !!draft &&
    !!business &&
    (draft.name !== business.name ||
      draft.ownerName !== business.ownerName ||
      draft.notifyOnNewOrder !== business.notifyOnNewOrder ||
      draft.notifyOnLowStock !== business.notifyOnLowStock ||
      draft.notifyOnPayment !== business.notifyOnPayment);

  const savedTemplates = templatesFromCatalogue(templateCatalogue);
  const dirtyTemplateCount = (templateCatalogue ?? []).filter(
    (entry) => draftTemplates[entry.key] !== savedTemplates[entry.key],
  ).length;
  const templatesDirty = dirtyTemplateCount > 0;

  // The profile is a nested object, so a structural compare is the honest test.
  // At this size a stringify is cheaper to read than a hand-written deep equal.
  const assistantDirty =
    !!draftAssistant &&
    !!business &&
    JSON.stringify(draftAssistant) !== JSON.stringify(assistantDraftFrom(business));

  const anyDirty = profileDirty || templatesDirty || assistantDirty;

  useUnsavedChangesWarning(anyDirty);

  function handleSave(): void {
    if (!anyDirty) return;

    const payload: UpdateBusinessInput = {};

    if (assistantDirty && draftAssistant) {
      payload.businessType = draftAssistant.businessType;
      payload.businessTypeOther = draftAssistant.businessTypeOther;
      payload.businessProfile = draftAssistant.businessProfile;
      payload.businessPolicyNotes = draftAssistant.businessPolicyNotes;
      payload.aiAssistMode = draftAssistant.aiAssistMode;
      payload.catalogueMode = draftAssistant.catalogueMode;
    }

    if (draft) {
      if (profileDirty) {
        payload.name = draft.name;
        payload.ownerName = draft.ownerName;
        payload.notifyOnNewOrder = draft.notifyOnNewOrder;
        payload.notifyOnLowStock = draft.notifyOnLowStock;
        payload.notifyOnPayment = draft.notifyOnPayment;
      }
      if (templatesDirty) {
        // Only genuinely customised templates are sent. Persisting a copy of
        // every default would freeze this owner's wording, so later
        // improvements to the shipped defaults would never reach them.
        const overrides: Record<string, string> = {};
        for (const entry of templateCatalogue ?? []) {
          const value = draftTemplates[entry.key];
          if (value !== undefined && value !== entry.defaultText) {
            overrides[entry.key] = value;
          }
        }
        payload.replyTemplates = { overrides };
      }
    }

    updateBusiness.mutate(payload, { onSuccess: () => setDraft(null) });
  }

  function handleDiscard(): void {
    setDraft(null);
    setDraftTemplates(templatesFromCatalogue(templateCatalogue));
    if (business) setDraftAssistant(assistantDraftFrom(business));
  }

  if (isLoading || !business) {
    return (
      <div className="flex flex-col gap-5">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const flags = {
    pendingOrders: badges?.pendingOrders ?? 0,
    reviewMessages: badges?.reviewMessages ?? 0,
    lowStock: badges?.lowStockProducts ?? 0,
  };

  const plan = getPlan(business.plan);
  const trialDaysLeft = business.trialEndsAt
    ? Math.max(
        0,
        Math.ceil((new Date(business.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      )
    : null;

  return (
    // Bottom padding leaves room for the save bar so it never covers the last
    // control on the page.
    <div className={cn('flex flex-col gap-5', anyDirty && 'pb-20')}>
      <PageHeader
        title="Settings"
        description="Connection, replies, and billing."
      />

      {/* The connection sits above the tabs because it is the only setting
          that can stop the entire product working. */}
      <WhatsAppConnection />

      {wantsWhatsAppSetup && (
        <p className="rounded-lg border border-info-border bg-info-muted px-4 py-3 text-sm text-text-secondary">
          Connect your number above. Everything else can wait.
        </p>
      )}

      <div>
        <Tabs label="Settings sections" options={TAB_OPTIONS} value={tab} onChange={setTab} />

        <div className="mt-5 flex flex-col gap-5">
          {/* ── Business ── */}
          {tab === 'business' && (
            <>
              <Panel>
                <PanelHead title="Business details" />
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-text-primary">Business name</span>
                    <input
                      value={draft?.name ?? ''}
                      onChange={(e) =>
                        setDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))
                      }
                      className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                    />
                    <span className="text-xs text-text-muted">
                      Used in replies wherever a template has{' '}
                      <code className="fd-figure">{'{business}'}</code>.
                    </span>
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-text-primary">Your name</span>
                    <input
                      value={draft?.ownerName ?? ''}
                      onChange={(e) =>
                        setDraft((prev) => (prev ? { ...prev, ownerName: e.target.value } : prev))
                      }
                      className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                    />
                  </label>
                </div>
              </Panel>

              <Panel>
                <PanelHead title="What Flowdesk tells you about" />
                <RowList>
                  <ToggleRow
                    label="A new order arrives"
                    description="Someone places or changes an order."
                    checked={draft?.notifyOnNewOrder ?? business.notifyOnNewOrder}
                    onChange={(v) =>
                      setDraft((prev) => (prev ? { ...prev, notifyOnNewOrder: v } : prev))
                    }
                  />
                  <ToggleRow
                    label="A product runs low"
                    description="Stock drops to or below the level you set for it."
                    checked={draft?.notifyOnLowStock ?? business.notifyOnLowStock}
                    onChange={(v) =>
                      setDraft((prev) => (prev ? { ...prev, notifyOnLowStock: v } : prev))
                    }
                  />
                  <ToggleRow
                    label="A payment comes in"
                    description="A payment is recorded, whether or not it has been verified."
                    checked={draft?.notifyOnPayment ?? business.notifyOnPayment}
                    onChange={(v) =>
                      setDraft((prev) => (prev ? { ...prev, notifyOnPayment: v } : prev))
                    }
                  />
                </RowList>
              </Panel>

              <Panel>
                <PanelHead title="Right now" />
                <RowList>
                  <Row>
                    <span className="text-sm text-text-secondary">Orders waiting</span>
                    <span
                      className={cn(
                        'fd-figure text-sm font-semibold',
                        flags.pendingOrders > 0 ? 'text-warning' : 'text-text-muted',
                      )}
                    >
                      {flags.pendingOrders}
                    </span>
                  </Row>
                  <Row>
                    <span className="text-sm text-text-secondary">Messages needing you</span>
                    <span
                      className={cn(
                        'fd-figure text-sm font-semibold',
                        flags.reviewMessages > 0 ? 'text-danger' : 'text-text-muted',
                      )}
                    >
                      {flags.reviewMessages}
                    </span>
                  </Row>
                  <Row>
                    <span className="text-sm text-text-secondary">Products running low</span>
                    <span
                      className={cn(
                        'fd-figure text-sm font-semibold',
                        flags.lowStock > 0 ? 'text-warning' : 'text-text-muted',
                      )}
                    >
                      {flags.lowStock}
                    </span>
                  </Row>
                </RowList>
              </Panel>
            </>
          )}

          {/* ── Replies ── */}
          {tab === 'assistant' && draftAssistant && (
            <BusinessProfileForm
              businessType={draftAssistant.businessType}
              businessTypeOther={draftAssistant.businessTypeOther}
              profile={draftAssistant.businessProfile}
              policyNotes={draftAssistant.businessPolicyNotes}
              assistMode={draftAssistant.aiAssistMode}
              catalogueMode={draftAssistant.catalogueMode}
              onChange={(patch) =>
                setDraftAssistant((prev) => (prev ? { ...prev, ...patch } : prev))
              }
            />
          )}

          {tab === 'replies' && (
            <Panel>
              <PanelHead
                title="Automatic replies"
                meta={dirtyTemplateCount > 0 ? `${dirtyTemplateCount} edited` : undefined}
                action={
                  confirmingReset ? (
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs text-text-secondary">Reset all replies?</span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setDraftTemplates(resetAllToDefaults(templateCatalogue));
                          setConfirmingReset(false);
                        }}
                      >
                        Reset
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingReset(true)}
                      leadingIcon={<RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />}
                    >
                      Reset all
                    </Button>
                  )
                }
              />

              <div className="border-b border-border-subtle px-4 py-3">
                <p className="max-w-prose text-sm text-text-secondary">
                  Sent on your behalf. Anything in brackets is replaced before sending, so{' '}
                  <code className="fd-figure rounded-xs bg-surface-sunken px-1">{'{ref}'}</code>{' '}
                  becomes the actual order number.
                </p>
              </div>

              <div className="divide-y divide-border-subtle">
                {(templateCatalogue ?? []).map((m) => {
                  const isDirty = draftTemplates[m.key] !== savedTemplates[m.key];

                  return (
                    <div key={m.key} className="p-4">
                      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <label
                          htmlFor={`template-${m.key}`}
                          className="text-sm font-semibold text-text-primary"
                        >
                          {m.label}
                        </label>

                        <span className="flex flex-wrap items-center gap-1.5">
                          {m.variables.map((p) => (
                            <code
                              key={p}
                              className="fd-figure rounded-xs bg-surface-sunken px-1 py-px text-2xs text-text-secondary"
                            >
                              {`{${p}}`}
                            </code>
                          ))}
                          {isDirty && (
                            <button
                              type="button"
                              onClick={() =>
                                setDraftTemplates((prev) => ({
                                  ...prev,
                                  [m.key]: m.defaultText,
                                }))
                              }
                              className="rounded-sm px-1.5 py-px text-2xs font-semibold text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                              Undo
                            </button>
                          )}
                        </span>
                      </div>

                      <p className="mb-2 text-xs text-text-muted">{m.description}</p>

                      <textarea
                        id={`template-${m.key}`}
                        value={draftTemplates[m.key]}
                        onChange={(e) =>
                          setDraftTemplates((prev) => ({ ...prev, [m.key]: e.target.value }))
                        }
                        rows={2}
                        className={cn('fd-input fd-input-compact resize-y', isDirty && 'border-primary-border')}
                      />
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {/* ── Plan ── */}
          {tab === 'plan' && (
            <>
              {billingReturn && (
                <p
                  role="status"
                  className="rounded-lg border border-success-border bg-success-muted px-4 py-3 text-sm font-medium text-success"
                >
                  Payment received. Your new plan may take a few seconds to show here.
                </p>
              )}
              {billingCancelled && (
                <p
                  role="status"
                  className="rounded-lg border border-warning-border bg-warning-muted px-4 py-3 text-sm font-medium text-warning"
                >
                  Checkout was cancelled. Nothing was charged.
                </p>
              )}

              <Panel>
                <PanelHead title="Your plan" />

                <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]">
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-lg font-bold tracking-tight text-text-primary">
                        {plan.name}
                      </span>
                      <span className="fd-figure text-sm text-text-secondary">{plan.price}</span>
                    </div>

                    <p className="text-sm text-text-secondary">
                      {limit(plan.conversationsPerMonth)} conversations a month
                    </p>

                    <p className="text-sm text-text-secondary">
                      Used this month:{' '}
                      <span className="fd-figure font-semibold text-text-primary">
                        {business.monthlyConvoCount.toLocaleString()}
                      </span>
                    </p>

                    {trialDaysLeft !== null && (
                      <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
                        <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                        {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left in your trial
                      </p>
                    )}

                    <p className="fd-figure text-sm text-text-muted">{business.phone}</p>
                  </div>

                  <ul className="flex flex-col gap-1.5 border-t border-border-subtle pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
                    {planHighlights(plan).map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm text-text-secondary">
                        <span
                          aria-hidden="true"
                          className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary"
                        />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>

              <Panel>
                <PanelHead title="Change plan" />
                <div className="grid gap-3 p-4 sm:grid-cols-3">
                  {BILLABLE_PLAN_CODES.map((code) => {
                    const details = PLANS[code];
                    const isCurrent = business.plan === code;
                    const isBusy = checkout.isPending && checkout.variables === code;

                    return (
                      <div
                        key={code}
                        className={cn(
                          'flex flex-col rounded-md border p-3.5',
                          isCurrent ? 'border-primary bg-primary-light' : 'border-border',
                        )}
                      >
                        <span className="text-sm font-bold text-text-primary">{details.name}</span>
                        <span className="fd-figure mt-1 text-sm text-text-secondary">
                          {details.price}
                        </span>
                        <span className="mt-2 flex-1 text-xs text-text-muted">
                          {limit(details.conversationsPerMonth)} conversations a month
                        </span>

                        <Button
                          size="sm"
                          variant={isCurrent ? 'secondary' : 'primary'}
                          className="mt-3.5"
                          fullWidth
                          disabled={isCurrent || checkout.isPending}
                          isLoading={isBusy}
                          onClick={() => handleUpgrade(code as BillablePlan)}
                        >
                          {isCurrent ? 'Your plan' : 'Switch to this'}
                        </Button>
                      </div>
                    );
                  })}
                </div>

                {checkout.isError && (
                  <p role="alert" className="px-4 pb-4 text-sm font-medium text-danger">
                    {(checkout.error as Error).message}
                  </p>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>

      {/* ── Save bar ──────────────────────────────────────────────────────
          Appears only when there is something to save, and reports what.
          Fixed rather than sticky so it clears the phone navigation bar. */}
      {anyDirty && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-sticky px-4 pb-2 md:bottom-0 md:px-6 md:pb-4">
          <div className="mx-auto flex max-w-shell items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg">
            <span className="min-w-0 text-sm text-text-secondary">
              <span className="font-medium text-text-primary">Unsaved changes</span>
              {dirtyTemplateCount > 0 && (
                <span className="hidden sm:inline">
                  {' '}
                  in {dirtyTemplateCount} repl{dirtyTemplateCount === 1 ? 'y' : 'ies'}
                  {profileDirty ? ' and your business details' : ''}
                </span>
              )}
            </span>

            <span className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" onClick={handleDiscard}>
                Discard
              </Button>
              <Button size="sm" onClick={handleSave} isLoading={updateBusiness.isPending}>
                Save
              </Button>
            </span>
          </div>

          {updateBusiness.isError && (
            <p
              role="alert"
              className="mx-auto mt-2 max-w-shell rounded-md border border-danger-border bg-danger-muted px-4 py-2 text-sm font-medium text-danger"
            >
              {(updateBusiness.error as Error).message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A switch on a rule.
 *
 * The input is a real checkbox behind the visual, so it is focusable, toggles
 * with the space bar, and reports its state to a screen reader without any
 * ARIA. The visible track is drawn from `peer-checked`.
 */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 px-4 py-3 transition-colors duration-fast ease-out hover:bg-surface-hover">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-secondary">{description}</span>
      </span>

      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="h-5 w-9 rounded-full bg-border-strong transition-colors duration-fast ease-out peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-xs transition-transform duration-fast ease-out peer-checked:translate-x-4" />
      </span>
    </label>
  );
}
