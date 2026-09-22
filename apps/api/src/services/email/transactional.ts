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
 *
 * Returns whether Resend accepted the message. Callers that tell a user how
 * something was delivered need to know the difference between "sent" and
 * "logged because no provider is configured"; a void return let the staff
 * invite path claim an email had gone out when nothing had.
 */
async function send(message: EmailMessage): Promise<boolean> {
  if (!features.email) {
    logger.warn(
      { to: message.to, subject: message.subject },
      'Email not configured — message not sent',
    );
    return false;
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
      return false;
    }

    logger.info({ to: message.to, subject: message.subject }, 'Email sent');
    return true;
  } catch (error: unknown) {
    logger.error({ error, to: message.to }, 'Email delivery error');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Escapes values interpolated into an email's HTML part.
 *
 * A business name and a staff member's name are typed by a user, and they land
 * in someone's inbox rendered as markup. Escaping them here keeps a name
 * containing a tag from becoming one.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function appUrl(path: string): string {
  const base = (env.FRONTEND_URL ?? 'http://localhost:5173').split(',')[0]!.trim();
  return `${base.replace(/\/$/, '')}${path}`;
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<boolean> {
  const link = appUrl(`/reset-password?token=${encodeURIComponent(rawToken)}`);

  return send({
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

/**
 * Emails a staff invite link.
 *
 * `inviteeName` is set when the mail is going to the owner to pass on rather
 * than to the new staff member directly — which is every case today, because
 * `Staff` has no email column and the only address on file is the business's
 * own. The wording changes with it, so the message reads correctly to whoever
 * opens it instead of greeting the owner as their own new hire.
 */
export async function sendStaffInviteEmail(
  to: string,
  businessName: string,
  rawToken: string,
  inviteeName?: string,
): Promise<boolean> {
  const link = appUrl(`/staff/accept?token=${encodeURIComponent(rawToken)}`);

  if (inviteeName) {
    return send({
      to,
      subject: `Invite link for ${inviteeName} at ${businessName}`,
      text: `${inviteeName} has been added to ${businessName} on Flowdesk.\n\nSend them this link so they can set up their access. It expires in seven days.\n\n${link}`,
      html: `
        <p><strong>${escapeHtml(inviteeName)}</strong> has been added to <strong>${escapeHtml(businessName)}</strong> on Flowdesk.</p>
        <p>Send them this link so they can set up their access. It expires in seven days.</p>
        <p><a href="${link}">${link}</a></p>
      `,
    });
  }

  return send({
    to,
    subject: `You have been invited to ${businessName} on Flowdesk`,
    text: `You have been invited to help manage ${businessName} on Flowdesk.\n\nSet up your access here:\n${link}`,
    html: `
      <p>You have been invited to help manage <strong>${escapeHtml(businessName)}</strong> on Flowdesk.</p>
      <p><a href="${link}">Set up your access</a></p>
    `,
  });
}


/**
 * A sign-in code.
 *
 * Plain text and a large monospaced number, and nothing else. Verification mail
 * is the most phished category there is, so this carries no link to click, no
 * button, and no "confirm your account" call to action: there is nothing in it
 * for an attacker to redirect. The only action it asks for is typing six digits
 * into a page the recipient already had open.
 */
export async function sendVerificationCodeEmail(
  to: string,
  ownerName: string,
  code: string,
  validMinutes: number,
): Promise<boolean> {
  const firstName = ownerName.split(' ')[0] ?? 'there';

  return send({
    to,
    subject: `${code} is your Flowdesk code`,
    text:
      `Hi ${firstName},\n\n` +
      `Your Flowdesk verification code is ${code}.\n\n` +
      `It is valid for ${validMinutes} minutes and can be used once.\n\n` +
      'Flowdesk will never ask you for this code by WhatsApp, by phone, or in a reply to this email. ' +
      'If you did not ask for it, you can ignore this message and nothing will change.',
    html: `
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Your Flowdesk verification code is:</p>
      <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:0.12em;margin:24px 0;color:#0f161a;">${escapeHtml(code)}</p>
      <p>It is valid for ${validMinutes} minutes and can be used once.</p>
      <p style="color:#52656f;font-size:14px;">Flowdesk will never ask you for this code by WhatsApp, by phone, or in a reply to this email. If you did not ask for it, you can ignore this message and nothing will change.</p>
    `,
  });
}
