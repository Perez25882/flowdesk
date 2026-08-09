import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const RESEND_API_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends a transactional email via Resend.
 *
 * When email is not configured the message is logged instead of sent, so local
 * development can follow the flow without an email provider. Delivery failures
 * never throw to the caller — an email outage must not fail the user's request.
 */
async function send(message: EmailMessage): Promise<void> {
  if (!features.email) {
    logger.warn(
      { to: message.to, subject: message.subject },
      'Email not configured — message not sent',
    );
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY as string}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL as string,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      logger.error({ status: response.status, body }, 'Email delivery failed');
      return;
    }

    logger.info({ to: message.to, subject: message.subject }, 'Email sent');
  } catch (error: unknown) {
    logger.error({ error, to: message.to }, 'Email delivery error');
  } finally {
    clearTimeout(timeout);
  }
}

function appUrl(path: string): string {
  const base = (env.FRONTEND_URL ?? 'http://localhost:5173').split(',')[0]!.trim();
  return `${base.replace(/\/$/, '')}${path}`;
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
  const link = appUrl(`/reset-password?token=${encodeURIComponent(rawToken)}`);

  await send({
    to,
    subject: 'Reset your Flowdesk password',
    text: `Reset your Flowdesk password using this link (valid for one hour):\n\n${link}\n\nIf you did not request this, you can safely ignore this email.`,
    html: `
      <p>Reset your Flowdesk password using the link below. It is valid for one hour.</p>
      <p><a href="${link}">Reset password</a></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    `,
  });
}

export async function sendStaffInviteEmail(
  to: string,
  businessName: string,
  rawToken: string,
): Promise<void> {
  const link = appUrl(`/staff/accept?token=${encodeURIComponent(rawToken)}`);

  await send({
    to,
    subject: `You have been invited to ${businessName} on Flowdesk`,
    text: `You have been invited to help manage ${businessName} on Flowdesk.\n\nSet up your access here:\n${link}`,
    html: `
      <p>You have been invited to help manage <strong>${businessName}</strong> on Flowdesk.</p>
      <p><a href="${link}">Set up your access</a></p>
    `,
  });
}
