import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, PlugZap } from 'lucide-react';
import { useWhatsAppStatus, type WhatsAppConnectionState } from '@/hooks/useWhatsApp';
import { cn } from '@/lib/utils';

/**
 * Warns the owner when their WhatsApp connection is not working.
 *
 * A broken connection is silent by nature: orders simply stop arriving and
 * replies stop going out, which looks identical to a quiet day. Surfacing it
 * prominently is the difference between a five-minute reconnect and a week of
 * lost orders.
 *
 * The banner leads with a thick left rule rather than a fully tinted panel. A
 * saturated red block at the top of every page becomes wallpaper within a
 * week; a rule stays legible without shouting, and the copy carries the
 * urgency instead of the colour.
 */

interface BannerContent {
  title: string;
  detail: string;
  action: string | null;
  tone: 'critical' | 'warning';
  Icon: typeof AlertTriangle;
}

function contentFor(state: WhatsAppConnectionState): BannerContent | null {
  switch (state) {
    case 'TOKEN_INVALID':
      return {
        title: 'WhatsApp disconnected',
        detail:
          'Your WhatsApp connection expired, so orders are not arriving and automatic replies have stopped.',
        action: 'Reconnect now',
        tone: 'critical',
        Icon: PlugZap,
      };
    case 'NUMBER_UNAVAILABLE':
      return {
        title: 'WhatsApp number unavailable',
        detail:
          'WhatsApp reports your number can no longer send messages. Check its status in Meta Business Manager.',
        action: 'Open settings',
        tone: 'critical',
        Icon: AlertTriangle,
      };
    case 'RATE_LIMITED':
      return {
        title: 'WhatsApp is limiting your messages',
        detail:
          'Replies are being sent more slowly than usual. This clears on its own, so there is nothing to do.',
        action: null,
        tone: 'warning',
        Icon: Clock,
      };
    // DISCONNECTED is handled by the onboarding flow, not an error banner.
    default:
      return null;
  }
}

const TONE_CLASSES: Record<BannerContent['tone'], { wrap: string; icon: string; rule: string }> = {
  critical: {
    wrap: 'border-danger-border bg-danger-muted',
    icon: 'text-danger',
    rule: 'bg-danger',
  },
  warning: {
    wrap: 'border-warning-border bg-warning-muted',
    icon: 'text-warning',
    rule: 'bg-warning',
  },
};

export default function WhatsAppHealthBanner(): React.JSX.Element | null {
  const { data: status } = useWhatsAppStatus();

  // Nothing to warn about until a number has actually been connected.
  if (!status?.connected) return null;

  const content = contentFor(status.state);
  if (!content) return null;

  const { Icon } = content;
  const tone = TONE_CLASSES[content.tone];

  return (
    <div
      role="alert"
      className={cn(
        'relative flex items-start gap-3 overflow-hidden rounded-lg border py-3 pl-4 pr-3 sm:items-center',
        tone.wrap,
      )}
    >
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1', tone.rule)} />

      <Icon
        className={cn('mt-0.5 h-[18px] w-[18px] shrink-0 sm:mt-0', tone.icon)}
        strokeWidth={1.9}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">{content.title}</p>
        <p className="mt-0.5 max-w-prose text-sm text-text-secondary">{content.detail}</p>
      </div>

      {content.action && (
        <Link
          to="/settings"
          className={cn(
            'shrink-0 self-start rounded-md border border-border-strong bg-surface px-3 py-1.5',
            'text-xs font-semibold text-text-primary sm:self-auto',
            'transition-colors duration-fast ease-out hover:bg-surface-hover',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          )}
        >
          {content.action}
        </Link>
      )}
    </div>
  );
}
