import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChangePassword, useCloseAccount, usePauseAccount } from '@/hooks/useAuth';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';

/**
 * The account itself: the password, pausing, and closing.
 *
 * None of this had anywhere to live. `useChangePassword` existed and was called
 * from nothing, and pausing and closing did not exist at all — an owner who
 * wanted to step away or leave had to email someone. A product that can be
 * joined but not left is not finished.
 *
 * The three are stacked in ascending order of consequence, and only the last is
 * styled as dangerous. Making all three look alarming would teach an owner to
 * ignore the styling.
 */
export default function AccountSettings(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <ChangePassword />
      <PauseShop />
      <CloseAccount />
    </div>
  );
}

function ChangePassword(): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useChangePassword();

  const tooShort = next.length > 0 && next.length < 8;
  const ready = current.length > 0 && next.length >= 8;

  return (
    <Panel>
      <PanelHead title="Password" />
      <form
        className="flex flex-col gap-3 px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          change.mutate(
            { currentPassword: current, newPassword: next },
            {
              onSuccess: () => {
                setCurrent('');
                setNext('');
              },
            },
          );
        }}
      >
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          hint="At least 8 characters."
          {...(tooShort ? { error: 'Use at least 8 characters.' } : {})}
        />

        <p className="text-2xs text-text-muted">
          Changing your password signs out every device, including your staff.
        </p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready || change.isPending}>
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
          {change.isSuccess && <p className="text-xs text-success">{change.data.message}</p>}
        </div>
        {change.error && <p className="text-xs text-danger">{change.error.message}</p>}
      </form>
    </Panel>
  );
}

function PauseShop(): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const pause = usePauseAccount();
  const navigate = useNavigate();

  return (
    <Panel>
      <PanelHead title="Pause your shop" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-sm text-text-secondary">
          Your assistant stops replying to customers. Nothing is deleted — your orders, customers
          and products stay exactly as they are, and messages keep arriving for when you return.
        </p>
        <p className="text-2xs text-text-muted">Sign in again to start your shop back up.</p>

        {!confirming ? (
          <div>
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Pause my shop
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!password) return;
              pause.mutate({ password }, { onSuccess: () => navigate('/login') });
            }}
          >
            <TextField
              label="Confirm with your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" variant="secondary" disabled={!password || pause.isPending}>
                {pause.isPending ? 'Pausing…' : 'Pause my shop'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
            {pause.error && <p className="text-xs text-danger">{pause.error.message}</p>}
          </form>
        )}
      </div>
    </Panel>
  );
}

/** The word the API requires. Typed out rather than clicked. */
const CONFIRMATION = 'DELETE';

function CloseAccount(): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [confirming, setConfirming] = useState(false);
  const close = useCloseAccount();
  const navigate = useNavigate();

  const ready = password.length > 0 && typed === CONFIRMATION;

  return (
    <Panel className="border-danger/30">
      <PanelHead title="Close your account" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-sm text-text-secondary">
          Your shop stops for good, your subscription is cancelled, and you are signed out
          everywhere. Your WhatsApp number keeps working — it just stops being connected to
          Flowdesk.
        </p>
        <p className="text-2xs text-text-muted">
          This cannot be undone. If you only want a break, pause your shop instead.
        </p>

        {!confirming ? (
          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Close my account
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ready) return;
              close.mutate(
                { password, confirmation: typed },
                { onSuccess: () => navigate('/login') },
              );
            }}
          >
            <TextField
              label="Confirm with your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <TextField
              label={`Type ${CONFIRMATION} to confirm`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" variant="danger" disabled={!ready || close.isPending}>
                {close.isPending ? 'Closing…' : 'Close my account for good'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
            {close.error && <p className="text-xs text-danger">{close.error.message}</p>}
          </form>
        )}
      </div>
    </Panel>
  );
}
