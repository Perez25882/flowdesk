import { randomUUID } from 'node:crypto';
import { prisma } from '../../config/database.js';
import { features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { deleteObject, getArchivedMedia, uploadBufferToS3 } from '../s3/media.js';
import { describeRejection, inspectImageUpload } from '../media/image-file.js';
import {
  MetaMediaUploadError,
  uploadMediaToMeta,
  type TenantCredentials,
} from '../whatsapp/client.js';
import { formatAmount } from '../templates/template-engine.js';
import { deliverText, loadNotificationContext } from './customer-notifications.js';

/**
 * The receipt a customer gets when their payment lands.
 *
 * Worth more than it looks. A customer who has just sent money to a shop they
 * found on WhatsApp has, until this arrives, nothing at all — and "did it go
 * through?" is the message that follows every unreceipted payment. It is also
 * the cheapest branding a small shop will ever get: their logo, in a message
 * the customer keeps and forwards to whoever asked them to buy the thing.
 *
 * The receipt is the shop's logo carrying the detail as its caption, rather
 * than a rendered image of a receipt. That is a deliberate trade: rendering
 * text into a PNG server-side needs a native rasteriser, which is a build
 * dependency that breaks differently on Windows, on Render and in CI — and in
 * exchange the customer would get something they cannot copy, search or select
 * a reference number out of. If that judgement ever changes, the only thing
 * that moves is what `sendPaymentReceipt` hands to `deliverText`: the composed
 * text becomes a rendered buffer and everything either side stays as it is.
 */

/** Meta caps an image caption at 1024 characters and rejects the whole message above it. */
const MAX_CAPTION = 1024;

/** A logo is a small square. Anything larger is a photo someone picked by mistake. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const MEDIA_ID_TTL_MS = 20 * 24 * 60 * 60 * 1000;

export interface ReceiptLines {
  businessName: string;
  amount: number;
  reference: string | null;
  orderReference: string | null;
  method: string;
  paidAt: Date;
  /** What is still owed on the order, when this did not clear it. */
  balance: number | null;
  items: Array<{ name: string; quantity: number; total: number }>;
}

const METHOD_LABELS: Record<string, string> = {
  MOMO_MTN: 'MTN MoMo',
  MOMO_VODAFONE: 'Telecel Cash',
  MOMO_AIRTELTIGO: 'AirtelTigo Money',
  CARD: 'Card',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Payment',
};

/**
 * The receipt, as a person reads it.
 *
 * Amount first, because that is the only line anyone checks twice. The
 * reference is last and on its own line so it can be selected and pasted into
 * a complaint, which is the one moment a receipt actually earns its keep.
 */
export function composeReceipt(receipt: ReceiptLines): string {
  const lines: string[] = [];

  lines.push(`*${receipt.businessName}*`);
  lines.push(`Payment received — ${formatAmount(receipt.amount)}`);
  lines.push('');

  if (receipt.items.length > 0) {
    for (const item of receipt.items.slice(0, 8)) {
      lines.push(`${item.quantity} × ${item.name} — ${formatAmount(item.total)}`);
    }
    if (receipt.items.length > 8) {
      lines.push(`…and ${receipt.items.length - 8} more`);
    }
    lines.push('');
  }

  lines.push(`Paid with: ${METHOD_LABELS[receipt.method] ?? 'Payment'}`);
  lines.push(`Date: ${formatReceiptDate(receipt.paidAt)}`);

  if (receipt.orderReference) lines.push(`Order: ${receipt.orderReference}`);

  // Stated only when there is one, and stated plainly. A customer who still
  // owes money and is not told finds out in an argument later.
  if (receipt.balance !== null && receipt.balance > 0) {
    lines.push(`Still to pay: ${formatAmount(receipt.balance)}`);
  } else if (receipt.balance !== null) {
    lines.push('Paid in full. Thank you!');
  }

  if (receipt.reference) {
    lines.push('');
    lines.push(`Ref: ${receipt.reference}`);
  }

  return lines.join('\n').slice(0, MAX_CAPTION);
}

/**
 * Ghanaian order: day, month, year, then the time.
 *
 * Built by hand rather than with `toLocaleString`, because the server's locale
 * and timezone are whatever the host decided and a receipt showing a customer
 * a time three hours off is a receipt they will query.
 */
function formatReceiptDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Ghana is UTC+0 year round, with no daylight saving, so UTC IS local time
  // here. Said explicitly because it is the one assumption in this file that
  // would silently break if the product ever left Ghana.
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hours}:${minutes}`;
}

/**
 * Sends the receipt for a payment.
 *
 * Never throws at the caller. A receipt failing must not roll back or retry the
 * settlement that produced it — the money is real whether or not the message
 * went out, and a retry loop here would re-credit nothing but would re-send.
 */
export async function sendPaymentReceipt(paymentId: string): Promise<void> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        amount: true,
        method: true,
        reference: true,
        createdAt: true,
        attestedAt: true,
        businessId: true,
        customerId: true,
        business: { select: { name: true, receiptsEnabled: true } },
        order: {
          select: {
            referenceNumber: true,
            totalAmount: true,
            amountPaid: true,
            items: { select: { description: true, quantity: true, subtotal: true } },
          },
        },
      },
    });

    if (!payment) return;
    if (!payment.business.receiptsEnabled) return;

    const context = await loadNotificationContext(payment.businessId, payment.customerId);
    if (!context) return;

    const text = composeReceipt({
      businessName: payment.business.name,
      amount: Number(payment.amount),
      reference: payment.reference,
      orderReference: payment.order?.referenceNumber ?? null,
      method: payment.method,
      paidAt: payment.attestedAt ?? payment.createdAt,
      balance: payment.order
        ? Math.max(Number(payment.order.totalAmount) - Number(payment.order.amountPaid), 0)
        : null,
      items:
        payment.order?.items.map((item) => ({
          name: item.description,
          quantity: Number(item.quantity),
          total: Number(item.subtotal),
        })) ?? [],
    });

    const logoImage = await resolveLogoAttachment(payment.businessId);

    await deliverText(context, text, {
      // A receipt answers a payment the customer just made, so it is theirs to
      // receive whether or not the owner happens to be typing — the takeover
      // gate exists to stop the assistant talking over a conversation, and this
      // is a record, not a conversation.
      humanInitiated: true,
      idempotencyKey: `receipt-${paymentId}`,
      ...(logoImage ? { logoMediaId: logoImage } : {}),
    });
  } catch (error: unknown) {
    logger.error({ error, paymentId }, 'Failed to send a payment receipt');
  }
}

/**
 * The shop's logo as a Meta media id, uploading it once and caching it.
 *
 * Same shape as the product-photo cache and for the same reasons: a media id is
 * scoped to the phone number that uploaded it and lapses after about thirty
 * days, so both the id and the number it belongs to are stored.
 */
export async function resolveLogoAttachment(businessId: string): Promise<string | null> {
  const { loadTenantCredentials } = await import('../whatsapp/client.js');
  const credentials = await loadTenantCredentials(businessId);
  if (!credentials) return null;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      logoKey: true,
      logoMimeType: true,
      logoWaMediaId: true,
      logoWaMediaPhoneNumberId: true,
      logoWaMediaUploadedAt: true,
    },
  });

  if (!business?.logoKey) return null;

  if (
    business.logoWaMediaId &&
    business.logoWaMediaPhoneNumberId === credentials.phoneNumberId &&
    business.logoWaMediaUploadedAt &&
    Date.now() - business.logoWaMediaUploadedAt.getTime() < MEDIA_ID_TTL_MS
  ) {
    return business.logoWaMediaId;
  }

  const stored = await getArchivedMedia(business.logoKey);
  if (!stored) return null;

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stored.body) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : Buffer.from(chunk));
    }
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Could not read the shop logo out of storage');
    return null;
  }

  return uploadLogo(credentials, Buffer.concat(chunks), business.logoMimeType ?? 'image/png');
}

async function uploadLogo(
  credentials: TenantCredentials,
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    const mediaId = await uploadMediaToMeta(credentials, buffer, mimeType);
    await prisma.business.update({
      where: { id: credentials.businessId },
      data: {
        logoWaMediaId: mediaId,
        logoWaMediaPhoneNumberId: credentials.phoneNumberId,
        logoWaMediaUploadedAt: new Date(),
      },
    });
    return mediaId;
  } catch (error: unknown) {
    if (error instanceof MetaMediaUploadError) {
      logger.warn({ businessId: credentials.businessId }, 'Meta rejected the shop logo');
    } else {
      logger.error({ error, businessId: credentials.businessId }, 'Could not upload the shop logo');
    }
    return null;
  }
}

export interface LogoView {
  /** API path the dashboard fetches the bytes from. Null when none is set. */
  path: string | null;
  mimeType: string | null;
}

export async function getLogo(businessId: string): Promise<LogoView> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { logoKey: true, logoMimeType: true },
  });

  return {
    path: business?.logoKey ? '/settings/logo/file' : null,
    mimeType: business?.logoMimeType ?? null,
  };
}

/**
 * Stores a new logo, and forgets the cached Meta id for the old one.
 *
 * Clearing the cache is the part that matters: without it, a shop that changes
 * its logo keeps sending the old one on every receipt for up to twenty days,
 * and nothing in the product would explain why.
 */
export async function setLogo(businessId: string, encoded: string): Promise<LogoView> {
  if (!features.mediaStorage) {
    throw new ValidationError('Photo storage is not set up on this deployment yet.');
  }

  const inspection = inspectImageUpload(encoded);
  if (!inspection.ok) throw new ValidationError(describeRejection(inspection.reason));

  const { buffer, mimeType, sizeBytes } = inspection.image;
  if (sizeBytes > MAX_LOGO_BYTES) {
    throw new ValidationError('A logo should be under 2 MB. Crop it square and try again.');
  }

  const existing = await prisma.business.findUnique({
    where: { id: businessId },
    select: { logoKey: true },
  });

  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
  const key = `businesses/${businessId}/brand/${randomUUID()}.${extension}`;

  await uploadBufferToS3(buffer, key, mimeType);

  await prisma.business.update({
    where: { id: businessId },
    data: {
      logoKey: key,
      logoMimeType: mimeType,
      logoWaMediaId: null,
      logoWaMediaPhoneNumberId: null,
      logoWaMediaUploadedAt: null,
    },
  });

  if (existing?.logoKey) await deleteObject(existing.logoKey);

  return { path: '/settings/logo/file', mimeType };
}

export async function readLogoFile(businessId: string): ReturnType<typeof getArchivedMedia> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { logoKey: true },
  });

  if (!business?.logoKey) return null;
  return getArchivedMedia(business.logoKey);
}
