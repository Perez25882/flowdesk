import { useState, useEffect } from 'react';
import { Settings, Bell, MessageSquare, Package, CreditCard } from 'lucide-react';

interface BusinessSettings {
  name: string;
  ownerName: string;
  phone: string;
  plan: string;
  waWebhookVerified: boolean;
  notifyOnNewOrder: boolean;
  notifyOnLowStock: boolean;
  notifyOnPayment: boolean;
}

export default function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    fetch('/api/v1/businesses/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => { setSettings(d.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    const token = localStorage.getItem('accessToken');
    await fetch('/api/v1/businesses/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: settings.name,
        ownerName: settings.ownerName,
        notifyOnNewOrder: settings.notifyOnNewOrder,
        notifyOnLowStock: settings.notifyOnLowStock,
        notifyOnPayment: settings.notifyOnPayment,
      }),
    });
    setSaving(false);
  };

  if (loading || !settings) {
    return <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Settings</h1>

      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Settings className="h-4 w-4" /> Business Profile
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Business Name</label>
            <input value={settings.name} onChange={(e) => setSettings({ ...settings, name: e.target.value })} className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Owner Name</label>
            <input value={settings.ownerName} onChange={(e) => setSettings({ ...settings, ownerName: e.target.value })} className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
          </div>
        </div>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Bell className="h-4 w-4" /> Notifications
        </h2>
        <div className="space-y-3">
          <label className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]"><MessageSquare className="h-4 w-4" /> New Order Alert</span>
            <input type="checkbox" checked={settings.notifyOnNewOrder} onChange={(e) => setSettings({ ...settings, notifyOnNewOrder: e.target.checked })} className="h-4 w-4" />
          </label>
          <label className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]"><Package className="h-4 w-4" /> Low Stock Alert</span>
            <input type="checkbox" checked={settings.notifyOnLowStock} onChange={(e) => setSettings({ ...settings, notifyOnLowStock: e.target.checked })} className="h-4 w-4" />
          </label>
          <label className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]"><CreditCard className="h-4 w-4" /> Payment Alert</span>
            <input type="checkbox" checked={settings.notifyOnPayment} onChange={(e) => setSettings({ ...settings, notifyOnPayment: e.target.checked })} className="h-4 w-4" />
          </label>
        </div>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <CreditCard className="h-4 w-4" /> Plan & Billing
        </h2>
        <div className="space-y-2 text-sm text-[var(--color-text-secondary)]">
          <p>Current plan: <span className="font-medium text-[var(--color-text-primary)]">{settings.plan}</span></p>
          <p>WhatsApp connected: <span className={settings.waWebhookVerified ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}>{settings.waWebhookVerified ? 'Yes' : 'No'}</span></p>
          <p>Phone: {settings.phone}</p>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full rounded-[var(--radius-md)] bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-light)] disabled:opacity-50 sm:w-auto sm:self-start"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}
