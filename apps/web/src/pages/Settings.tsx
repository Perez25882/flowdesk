import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Settings,
  Bell,
  MessageSquare,
  Package,
  CreditCard,
  ShieldCheck,
  AlertCircle,
  MessagesSquare,
  RotateCw,
  Loader2,
} from 'lucide-react';
import { useBusiness, useUpdateBusiness } from '@/hooks/useBusiness';
import { useBadges } from '@/hooks/useBadges';
import { useCheckout, type BillablePlan } from '@/hooks/useBilling';
import WhatsAppConnection from '@/components/settings/WhatsAppConnection';

interface DraftState {
  name: string;
  ownerName: string;
  notifyOnNewOrder: boolean;
  notifyOnLowStock: boolean;
  notifyOnPayment: boolean;
}

interface ReplyTemplatesDraft {
  orderReceived: string;
  orderConfirmed: string;
  orderReady: string;
  orderCancelled: string;
  paymentReceived: string;
  paymentPartial: string;
  lowStock: string;
  greeting: string;
  thanks: string;
  unknown: string;
}

type TemplateKey = keyof ReplyTemplatesDraft;

const TEMPLATE_META: Array<{ key: TemplateKey; label: string; description: string; placeholders: string[] }> = [
  {
    key: 'orderReceived',
    label: 'Order Received',
    description: 'Sent immediately when the system parses an order from WhatsApp.',
    placeholders: ['{reference}', '{customerName}'],
  },
  {
    key: 'orderConfirmed',
    label: 'Order Confirmed',
    description: 'Sent after the owner confirms the order.',
    placeholders: ['{reference}', '{total}', '{customerName}'],
  },
  {
    key: 'orderReady',
    label: 'Order Ready',
    description: 'Sent when the order is marked fulfilled and ready for pickup/delivery.',
    placeholders: ['{reference}'],
  },
  {
    key: 'orderCancelled',
    label: 'Order Cancelled',
    description: "Sent when an order is cancelled by the team.",
    placeholders: ['{reference}'],
  },
  {
    key: 'paymentReceived',
    label: 'Payment Received',
    description: 'Sent when a payment is logged against an order.',
    placeholders: ['{reference}', '{amount}'],
  },
  {
    key: 'paymentPartial',
    label: 'Partial Payment',
    description: 'Sent when a payment covers only part of an order.',
    placeholders: ['{reference}', '{amount}', '{balance}'],
  },
  {
    key: 'lowStock',
    label: 'Low Stock Alert',
    description: 'Sent to the owner when a product drops below its reorder threshold.',
    placeholders: ['{product}', '{stock}'],
  },
  {
    key: 'greeting',
    label: 'Greeting',
    description: 'Sent when a customer messages for the first time or just says hi.',
    placeholders: ['{businessName}'],
  },
  {
    key: 'thanks',
    label: 'Thanks',
    description: 'Sent on thank-you messages from customers.',
    placeholders: ['{businessName}'],
  },
  {
    key: 'unknown',
    label: 'Unknown Intent',
    description: 'Fallback when the system cannot classify a message.',
    placeholders: [],
  },
];

const DEFAULT_TEMPLATES: ReplyTemplatesDraft = {
  orderReceived:
    'Thank you for your order {reference}! We have received it and will confirm shortly.',
  orderConfirmed:
    'Your order {reference} is confirmed. Total: {total}. We will let you know when it is ready.',
  orderReady: 'Your order {reference} is ready for pickup. Thank you for shopping with us!',
  orderCancelled: 'Your order {reference} has been cancelled. If this was a mistake, please reply here.',
  paymentReceived: 'Payment of {amount} received for order {reference}. Thank you!',
  paymentPartial:
    'We received {amount} as partial payment for order {reference}. Outstanding: {balance}.',
  lowStock:
    'Heads up — {product} is running low ({stock} left). Re-order soon from your supplier.',
  greeting: 'Hello! Welcome to {businessName}. How can we help you today?',
  thanks: 'Thank you for shopping with us! Have a great day.',
  unknown:
    "Sorry, we couldn't understand your message. Reply with 'help' to see what we can do.",
};

const PLAN_DETAILS: Record<string, { label: string; price: string; conversations: string; features: string[] }> = {
  TRIAL: {
    label: '14-Day Trial',
    price: 'GHS 0',
    conversations: 'Up to 100 conversations',
    features: ['All Starter features', 'Test WhatsApp auto-parsing', 'Test MoMo auto-verification'],
  },
  STARTER: {
    label: 'Starter',
    price: 'GHS 150 / mo',
    conversations: '500 conversations/mo',
    features: ['Unlimited orders', 'Stock tracking', 'Auto-replies'],
  },
  BUSINESS: {
    label: 'Business',
    price: 'GHS 350 / mo',
    conversations: '2,500 conversations/mo',
    features: ['Up to 5 staff', 'Auto-reports', 'Priority MoMo verification'],
  },
  GROWTH: {
    label: 'Growth',
    price: 'GHS 700 / mo',
    conversations: '10,000 conversations/mo',
    features: ['Unlimited staff', 'Broadcast campaigns', 'Dedicated support'],
  },
  ENTERPRISE: {
    label: 'Enterprise',
    price: 'Custom',
    conversations: 'Unlimited',
    features: ['SLA', 'Custom integrations', 'Account manager'],
  },
  SUSPENDED: {
    label: 'Suspended',
    price: '—',
    conversations: '—',
    features: ['Account suspended — contact support'],
  },
};

const BILLABLE_UPGRADES: BillablePlan[] = ['STARTER', 'BUSINESS', 'GROWTH'];

function getPlanKey(plan: string): string {
  if (plan === 'TRIAL') return 'TRIAL';
  return plan;
}

function templatesFromReply(reply: Record<string, string> | null | undefined): ReplyTemplatesDraft {
  const out = { ...DEFAULT_TEMPLATES } as ReplyTemplatesDraft;
  if (!reply) return out;
  for (const meta of TEMPLATE_META) {
    if (reply[meta.key]) out[meta.key] = reply[meta.key]!;
  }
  return out;
}

export default function SettingsPage(): React.JSX.Element {
  const { data: business, isLoading, refetch: refetchBusiness } = useBusiness();
  const updateBusiness = useUpdateBusiness();
  const { data: badges } = useBadges();
  const checkout = useCheckout();
  const [searchParams, setSearchParams] = useSearchParams();

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [draftTemplates, setDraftTemplates] = useState<ReplyTemplatesDraft>(DEFAULT_TEMPLATES);

  // Detect a Paystack return. ?billing=return means the user bounced back from
  // the hosted checkout — refetch so they immediately see the upgraded plan.
  // ?billing=cancelled means they bailed before paying; show the same banner
  // but make the manual change obvious.
  const billingReturn = searchParams.get('billing') === 'return';
  const billingCancelled = searchParams.get('billing') === 'cancelled';

  useEffect(() => {
    if (!billingReturn && !billingCancelled) return;
    void refetchBusiness();
    // Strip the marker so a refresh doesn't re-trigger.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('billing');
      return next;
    }, { replace: true });
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
      setDraftTemplates(templatesFromReply(business.replyTemplates));
    }
  }, [business, draft]);

  const handleUpgrade = (plan: BillablePlan): void => {
    checkout.mutate(plan, {
      onSuccess: (data) => {
        window.location.href = data.authorizationUrl;
      },
    });
  };

  const profileDirty =
    !!draft &&
    !!business &&
    (draft.name !== business.name ||
      draft.ownerName !== business.ownerName ||
      draft.notifyOnNewOrder !== business.notifyOnNewOrder ||
      draft.notifyOnLowStock !== business.notifyOnLowStock ||
      draft.notifyOnPayment !== business.notifyOnPayment);

  const knownServerTemplates = templatesFromReply(business?.replyTemplates);
  const templatesDirty = TEMPLATE_META.some((m) => draftTemplates[m.key] !== knownServerTemplates[m.key]);

  const anyDirty = profileDirty || templatesDirty;

  const handleSave = (): void => {
    if (!anyDirty) return;
    const payload: {
      name?: string;
      ownerName?: string;
      notifyOnNewOrder?: boolean;
      notifyOnLowStock?: boolean;
      notifyOnPayment?: boolean;
      replyTemplates?: Record<string, string>;
    } = {};

    if (draft) {
      if (profileDirty) {
        payload.name = draft.name;
        payload.ownerName = draft.ownerName;
        payload.notifyOnNewOrder = draft.notifyOnNewOrder;
        payload.notifyOnLowStock = draft.notifyOnLowStock;
        payload.notifyOnPayment = draft.notifyOnPayment;
      }
      if (templatesDirty) {
        payload.replyTemplates = { ...draftTemplates };
      }
    }
    updateBusiness.mutate(payload, {
      onSuccess: () => setDraft(null),
    });
  };

  const handleResetTemplate = (key: TemplateKey): void => {
    setDraftTemplates((prev) => ({ ...prev, [key]: DEFAULT_TEMPLATES[key] }));
  };

  const handleResetAllTemplates = (): void => {
    if (!confirm('Reset all reply templates to the defaults?')) return;
    setDraftTemplates({ ...DEFAULT_TEMPLATES });
  };

  if (isLoading || !business) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Settings</h1>
        <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />
     </div>
    );
  }

  const flags = {
    pendingOrders: badges?.pendingOrders ?? 0,
    reviewMessages: badges?.reviewMessages ?? 0,
    lowStock: badges?.lowStockProducts ?? 0,
  };

  const plan = PLAN_DETAILS[getPlanKey(business.plan)] ?? PLAN_DETAILS.STARTER!;
  const trialDaysLeft =
    business.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(business.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Settings</h1>

      {/* WhatsApp Connection */}
      <WhatsAppConnection />

      {/* Plan & Billing */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <CreditCard className="h-4 w-4" /> Plan & Billing
       </h2>

        {billingReturn && (
          <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-success)] bg-[var(--color-success-muted)] px-3 py-2 text-sm text-[var(--color-success)]">
            Payment received. Plan changes may take a few seconds to reflect.
         </div>
        )}
        {billingCancelled && (
          <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-warning)] bg-[var(--color-warning-muted)] px-3 py-2 text-sm text-[var(--color-warning)]">
            Checkout was cancelled. No charges were made.
         </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-2 text-sm lg:col-span-2">
            <p>
              Current plan: <span className="font-medium text-[var(--color-text-primary)]">{plan.label}</span>
              <span className="ml-2 text-[var(--color-text-muted)]">{plan.price}</span>
           </p>
            <p className="text-[var(--color-text-secondary)]">{plan.conversations}</p>
            <p className="text-[var(--color-text-secondary)]">
              Conversations used this month:{' '}
              <span className="font-mono">{business.monthlyConvoCount.toLocaleString()}</span>
           </p>
            {trialDaysLeft !== null && (
              <p className="flex items-center gap-1.5 text-[var(--color-warning)]">
                <AlertCircle className="h-4 w-4" />
                {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left in your trial
             </p>
            )}
            <p
              className={`flex items-center gap-1.5 ${business.waWebhookVerified ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}
            >
              <ShieldCheck className="h-4 w-4" />
              WhatsApp: {business.waWebhookVerified ? 'Connected & verified' : 'Not verified'}
           </p>
            <p className="text-[var(--color-text-muted)]">Phone: {business.phone}</p>
         </div>
          <ul className="space-y-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3 text-xs text-[var(--color-text-secondary)]">
            {plan.features.map((f) => (
              <li key={f} className="flex items-start gap-1.5">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[var(--color-primary)]" />
                <span>{f}</span>
             </li>
            ))}
         </ul>
       </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Change plan</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {BILLABLE_UPGRADES.map((code) => {
              const details = PLAN_DETAILS[code]!;
              const isCurrent = business.plan === code;
              const isLoading = checkout.isPending && checkout.variables === code;
              return (
                <div
                  key={code}
                  className={`flex flex-col rounded-[var(--radius-sm)] border p-3 ${
                    isCurrent
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary-muted)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-elevated)]'
                  }`}
                >
                  <p className="text-sm font-semibold text-[var(--color-text-primary)]">{details.label}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{details.price}</p>
                  <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{details.conversations}</p>
                  <button
                    type="button"
                    disabled={isCurrent || checkout.isPending}
                    onClick={() => handleUpgrade(code)}
                    className="mt-3 inline-flex items-center justify-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-light)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : isCurrent ? 'Current plan' : 'Upgrade'}
                 </button>
               </div>
              );
            })}
         </div>
          {checkout.isError && (
            <p className="mt-3 text-xs text-[var(--color-danger)]">{(checkout.error as Error).message}</p>
          )}
       </div>
     </div>

      {/* Business Profile */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Settings className="h-4 w-4" /> Business Profile
       </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Business Name</label>
            <input
              value={draft?.name ?? ''}
              onChange={(e) => setDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
            />
         </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Owner Name</label>
            <input
              value={draft?.ownerName ?? ''}
              onChange={(e) => setDraft((prev) => (prev ? { ...prev, ownerName: e.target.value } : prev))}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
            />
         </div>
       </div>
     </div>

      {/* Notifications */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Bell className="h-4 w-4" /> Notifications
       </h2>
        <div className="space-y-3">
          <ToggleRow
            icon={<MessageSquare className="h-4 w-4" />}
            label="New Order Alert"
            description="Get notified when a customer places or updates an order."
            checked={draft?.notifyOnNewOrder ?? business.notifyOnNewOrder}
            onChange={(v) => setDraft((prev) => (prev ? { ...prev, notifyOnNewOrder: v } : prev))}
          />
          <ToggleRow
            icon={<Package className="h-4 w-4" />}
            label="Low Stock Alert"
            description="Ping me when a product drops below its reorder threshold."
            checked={draft?.notifyOnLowStock ?? business.notifyOnLowStock}
            onChange={(v) => setDraft((prev) => (prev ? { ...prev, notifyOnLowStock: v } : prev))}
          />
          <ToggleRow
            icon={<CreditCard className="h-4 w-4" />}
            label="Payment Alert"
            description="Get notified on new payment records (verified or pending)."
            checked={draft?.notifyOnPayment ?? business.notifyOnPayment}
            onChange={(v) => setDraft((prev) => (prev ? { ...prev, notifyOnPayment: v } : prev))}
          />
       </div>
     </div>

      {/* Reply Templates */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
            <MessagesSquare className="h-4 w-4" /> Reply Templates
         </h2>
          <button
            onClick={handleResetAllTemplates}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          >
            <RotateCw className="h-3 w-3" /> Reset all to default
         </button>
       </div>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Use <span className="font-mono text-[var(--color-text-secondary)]">{'{placeholders}'}</span> like{' '}
          <span className="font-mono text-[var(--color-text-secondary)]">{'{reference}'}</span> to inject dynamic values.
       </p>
        <div className="space-y-3">
          {TEMPLATE_META.map((m) => {
            const isDirty = draftTemplates[m.key] !== knownServerTemplates[m.key];
            return (
              <div key={m.key} className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                    {m.label}
                 </label>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                    {m.placeholders.map((p) => (
                      <span key={p} className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono">
                        {p}
                     </span>
                    ))}
                    {isDirty && (
                      <button
                        onClick={() => handleResetTemplate(m.key)}
                        className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                      >
                        Reset
                     </button>
                    )}
                 </div>
               </div>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">{m.description}</p>
                <textarea
                  value={draftTemplates[m.key]}
                  onChange={(e) =>
                    setDraftTemplates((prev) => ({ ...prev, [m.key]: e.target.value }))
                  }
                  rows={2}
                  className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                />
             </div>
            );
          })}
       </div>
     </div>

      {/* Realtime stats */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          Realtime Health
       </h2>
        <div className="grid grid-cols-3 gap-3 text-center">
          <RealtimeMetric label="Pending orders" value={flags.pendingOrders} tone="warning" />
          <RealtimeMetric label="Messages to review" value={flags.reviewMessages} tone="danger" />
          <RealtimeMetric label="Low stock items" value={flags.lowStock} tone="warning" />
       </div>
     </div>

      <div className="flex items-center justify-between gap-3">
        {updateBusiness.isError && (
          <p className="text-sm text-[var(--color-danger)]">{(updateBusiness.error as Error).message}</p>
        )}
        {updateBusiness.isSuccess && !anyDirty && (
          <p className="text-sm text-[var(--color-success)]">Saved</p>
        )}
        <button
          onClick={handleSave}
          disabled={!anyDirty || updateBusiness.isPending}
          className="ml-auto w-full rounded-[var(--radius-md)] bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-light)] disabled:opacity-50 sm:w-auto"
        >
          {updateBusiness.isPending ? 'Saving…' : 'Save Changes'}
       </button>
     </div>
   </div>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-start justify-between gap-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[var(--color-text-secondary)]">{icon}</span>
        <div>
          <span className="block text-sm text-[var(--color-text-primary)]">{label}</span>
          <span className="block text-xs text-[var(--color-text-muted)]">{description}</span>
       </div>
     </div>
      <span className="relative inline-flex">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="h-5 w-9 rounded-full bg-[var(--color-border)] transition-colors peer-checked:bg-[var(--color-primary)]" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
     </span>
   </label>
  );
}

function RealtimeMetric({ label, value, tone }: { label: string; value: number; tone: 'danger' | 'warning' }): React.JSX.Element {
  const color = tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]';
  return (
    <div className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3">
      <div className={`font-mono text-2xl font-semibold ${color}`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
   </div>
  );
}
