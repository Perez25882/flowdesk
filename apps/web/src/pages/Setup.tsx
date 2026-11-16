import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useOnboarding, providerLabels, type OnboardingState, type SetupProfile } from '@/hooks/useOnboarding';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHead } from '@/components/ui/Panel';
import PageHeader from '@/components/shared/PageHeader';

const profiles = [
  { value: 'ONLINE_RETAIL', label: 'Retail and online sales', description: 'Sell items from a catalogue and fulfil orders.' },
  { value: 'CUSTOM_ORDER', label: 'Custom orders', description: 'Quote made-to-order work before confirming orders.' },
  { value: 'APPOINTMENT', label: 'Appointments and repairs', description: 'Schedule visits, assign staff and take deposits.' },
  { value: 'PROFESSIONAL_SERVICES', label: 'Consultations and professional services', description: 'Qualify inquiries and reserve appointments.' },
] as const;

function ProfileForm({ state }: { state: OnboardingState }): React.JSX.Element {
  const [profile, select] = useState<SetupProfile | null>(state.profile);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (chosen: SetupProfile) => apiFetch<OnboardingState>('/onboarding/profile', {
      method: 'PUT', body: { profile: chosen, revision: state.profileRevision },
    }),
    onSuccess: (next) => {
      client.setQueryData(['onboarding'], next);
      void client.invalidateQueries({ queryKey: ['business'] });
      void client.invalidateQueries({ queryKey: ['workflow-settings'] });
    },
  });
  return <form id="profile" className="grid gap-4 p-4 sm:p-5" onSubmit={(event) => {
    event.preventDefault();
    if (profile && !save.isPending) save.mutate(profile);
  }}>
    <fieldset>
      <legend className="mb-3 font-semibold">How does your business work?</legend>
      <div className="grid gap-2 sm:grid-cols-2">{profiles.map((item) => <label key={item.value}
        className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-muted">
        <input type="radio" name="profile" value={item.value} required checked={profile === item.value}
          className="mt-1 accent-primary" onChange={() => select(item.value)} />
        <span><span className="block text-sm font-semibold">{item.label}</span><span className="mt-1 block text-sm text-text-secondary">{item.description}</span></span>
      </label>)}</div>
    </fieldset>
    <Button type="submit" className="justify-self-start" isLoading={save.isPending} disabled={!profile || profile === state.profile}>Save business profile</Button>
    {state.profile && <p role="status" className="text-sm text-text-secondary">Business profile saved.</p>}
    {save.isError && <p role="alert" className="text-sm text-danger">{save.error.message}</p>}
  </form>;
}

export default function SetupPage(): React.JSX.Element {
  const setup = useOnboarding();
  return <div className="grid gap-5">
    <PageHeader title="Business setup" description="Configure how your team sells, books and supports customers."
      actions={<Link to="/dashboard" className="inline-flex min-h-10 items-center font-medium text-primary underline underline-offset-4">Go to overview</Link>} />
    {setup.isPending && <p role="status">Loading business setup…</p>}
    {setup.isError && <div role="alert"><p>Business setup could not load.</p><Button onClick={() => void setup.refetch()}>Try again</Button></div>}
    {setup.data && <>
      <Panel><ProfileForm key={setup.data.profileRevision} state={setup.data} /></Panel>
      <Panel>
        <PanelHead title={setup.data.ready ? 'Workspace ready' : 'Get your workspace ready'} meta={setup.data.completed + ' of ' + setup.data.total + ' complete'} />
        <ul className="divide-y divide-border-subtle">{setup.data.steps.filter((step) => step.id !== 'profile').map((step) => {
          const provider = step.id === 'whatsapp' ? setup.data.providers.whatsapp : step.id === 'payouts' ? setup.data.providers.payments : null;
          const StatusIcon = step.done ? CheckCircle2 : Circle;
          return <li key={step.id} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:items-center">
            <StatusIcon aria-hidden="true" className={step.done ? 'mt-1 size-4 text-success' : 'mt-1 size-4 text-text-muted'} />
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-sm font-semibold">{step.title}</p>
              <p className="text-sm text-text-secondary">{step.why}</p>
              <p className="mt-1 text-xs text-text-secondary">{provider ? providerLabels[provider] : step.done ? 'Complete' : step.blocking ? 'Required for setup' : 'Optional'}</p>
            </div>
            <Link to={step.href} aria-label={'Open ' + step.title.toLowerCase()} className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline underline-offset-4">Open</Link>
          </li>;
        })}</ul>
      </Panel>
    </>}
  </div>;
}
