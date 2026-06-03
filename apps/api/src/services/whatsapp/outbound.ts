import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { prisma } from '../../config/database.js';

interface MetaApiResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

function normalizeToWaFormat(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) {
    return digits;
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return `233${digits.slice(1)}`;
  }
  if (digits.length === 9) {
    return `233${digits}`;
  }
  return digits;
}

export async function sendWhatsAppMessageGlobal(
  to: string,
  text: string,
): Promise<void> {
  const normalizedTo = normalizeToWaFormat(to);

  logger.info(
    { to: normalizedTo, textLength: text.length },
    'Sending WhatsApp message via global Meta credentials',
  );

  const phoneNumberId = env.META_PHONE_NUMBER_ID;
  const accessToken = env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error('Global WhatsApp credentials not configured');
  }

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    logger.error(
      { status: response.status, body: errorBody, to: normalizedTo },
      'Meta WhatsApp API returned non-OK status',
    );
    throw new Error(`Meta WhatsApp API error: ${response.status} - ${errorBody}`);
  }

  const data = (await response.json()) as MetaApiResponse;
  logger.info(
    { to: normalizedTo, messageId: data.messages?.[0]?.id },
    'WhatsApp message sent successfully via global credentials',
  );
}

export async function sendWhatsAppMessage(
  to: string,
  text: string,
  businessId: string,
): Promise<void> {
  const normalizedTo = normalizeToWaFormat(to);

  logger.info(
    { to: normalizedTo, textLength: text.length, businessId },
    'Sending WhatsApp message via Meta Cloud API',
  );

  // Look up per-business credentials; fall back to global env if not connected yet
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { waPhoneNumberId: true, waAccessToken: true, name: true },
  });

  const phoneNumberId = business?.waPhoneNumberId ?? env.META_PHONE_NUMBER_ID;
  const accessToken = business?.waAccessToken ?? env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error('No WhatsApp credentials available (business or global)');
  }

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    logger.error(
      { status: response.status, body: errorBody, to: normalizedTo, businessId },
      'Meta WhatsApp API returned non-OK status',
    );
    throw new Error(`Meta WhatsApp API error: ${response.status} - ${errorBody}`);
  }

  const data = (await response.json()) as MetaApiResponse;
  logger.info(
    { to: normalizedTo, messageId: data.messages?.[0]?.id, businessId },
    'WhatsApp message sent successfully',
  );
}

export async function sendWhatsAppTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string,
  businessId: string,
  components?: Array<Record<string, unknown>>,
): Promise<void> {
  const normalizedTo = normalizeToWaFormat(to);

  logger.info(
    { to: normalizedTo, templateName, languageCode, businessId },
    'Sending WhatsApp template message via Meta Cloud API',
  );

  // Look up per-business credentials; fall back to global env if not connected yet
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { waPhoneNumberId: true, waAccessToken: true },
  });

  const phoneNumberId = business?.waPhoneNumberId ?? env.META_PHONE_NUMBER_ID;
  const accessToken = business?.waAccessToken ?? env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error('No WhatsApp credentials available (business or global)');
  }

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${phoneNumberId}/messages`;

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };

  if (components && components.length > 0) {
    (body.template as Record<string, unknown>).components = components;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    logger.error(
      { status: response.status, body: errorBody, to: normalizedTo, templateName, businessId },
      'Meta WhatsApp template API returned non-OK status',
    );
    throw new Error(`Meta WhatsApp template API error: ${response.status} - ${errorBody}`);
  }

  const data = (await response.json()) as MetaApiResponse;
  logger.info(
    { to: normalizedTo, messageId: data.messages?.[0]?.id, templateName, businessId },
    'WhatsApp template message sent successfully',
  );
}
