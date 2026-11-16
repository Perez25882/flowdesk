import type { CommerceReminderPolicy, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { persistOutboundSend, type OutboundJobData } from '../../queues/outbound.queue.js';
import { loadTenantCredentials } from '../../services/whatsapp/client.js';
import { lockPaymentRelationship } from '../payments/payment-relationships.js';
import { findInvoiceForPayment, invoiceAmounts, invoiceIsPayable } from './commerce.invoices.js';
import type { CommerceRecoveryProbe } from './commerce.recovery.js';

type Tx = Prisma.TransactionClient;
const day = 86_400_000;
export const PAYMENT_REMINDER_TEMPLATE = 'Invoice {{1}} has an outstanding balance of GHS {{2}}. Contact the shop if you need help. Reply STOP PAYMENT REMINDERS to opt out.';
type ReminderSettings = Pick<CommerceReminderPolicy, 'enabled' | 'intervalDays' | 'maxReminders' | 'templateName' | 'templateLanguage'>;

export async function checkReminderTemplate(
  businessId: string, input: Pick<ReminderSettings, 'enabled' | 'templateName' | 'templateLanguage'>, expectedBody = PAYMENT_REMINDER_TEMPLATE,
): Promise<{
  approvedAt: Date | null; approvedWabaId: string | null; approvedPhoneId: string | null;
}> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { waWabaId: true } });
  const credentials = input.enabled && input.templateName && business.waWabaId ? await loadTenantCredentials(businessId) : null;
  let approved = false;
  if (credentials && business.waWabaId && /^\d+$/.test(business.waWabaId)) {
    const url = new URL(`https://graph.facebook.com/${env.META_API_VERSION}/${business.waWabaId}/message_templates`);
    url.searchParams.set('name', input.templateName!);
    url.searchParams.set('fields', 'name,language,status,category,components');
    url.searchParams.set('limit', '50');
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${credentials.accessToken}` },
        redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const result = await response.json() as { data?: Array<{ name: string; language: string; status: string; category: string;
          components?: Array<{ type: string; text?: string }> }> };
        approved = (result.data ?? []).some((item) => item.name === input.templateName && item.language === input.templateLanguage &&
          item.status === 'APPROVED' && item.category === 'UTILITY' && item.components?.length === 1 &&
          item.components[0]?.type === 'BODY' && item.components[0].text === expectedBody);
      }
    } catch {
      logger.warn({ businessId }, 'Unable to verify the payment reminder template');
    }
  }
  return { approvedAt: approved ? new Date() : null, approvedWabaId: approved ? business.waWabaId : null,
    approvedPhoneId: approved ? credentials!.phoneNumberId : null };
}

export async function saveReminderPolicy(businessId: string, input: ReminderSettings): Promise<CommerceReminderPolicy> {
  const values = { ...input, templateCheckedAt: new Date(), ...await checkReminderTemplate(businessId, input) };
  return prisma.commerceReminderPolicy.upsert({ where: { businessId }, create: { businessId, ...values }, update: values });
}

async function refreshDueTemplates(now: Date): Promise<void> {
  const stale = new Date(+now - 6 * 3_600_000);
  const policies = await prisma.$queryRaw<CommerceReminderPolicy[]>`
    SELECT p.* FROM commerce_reminder_policies p WHERE p.enabled AND p."templateName" IS NOT NULL
      AND (p."templateCheckedAt" IS NULL OR p."templateCheckedAt" <= ${stale})
      AND EXISTS (SELECT 1 FROM commerce_reminders r WHERE r."businessId" = p."businessId" AND r.status = 'WAITING')
    ORDER BY p."templateCheckedAt" NULLS FIRST, p."businessId" LIMIT 5
  `;
  for (const policy of policies) {
    const version = { businessId: policy.businessId, enabled: true, templateName: policy.templateName,
      templateLanguage: policy.templateLanguage, templateCheckedAt: policy.templateCheckedAt };
    const claimed = await prisma.commerceReminderPolicy.updateMany({ where: version, data: { templateCheckedAt: now } });
    if (!claimed.count) continue;
    const evidence = await checkReminderTemplate(policy.businessId, policy);
    const saved = await prisma.commerceReminderPolicy.updateMany({ where: { ...version, templateCheckedAt: now }, data: evidence });
    if (saved.count && evidence.approvedAt) await prisma.commerceReminder.updateMany({
      where: { businessId: policy.businessId, status: 'WAITING', reason: 'APPROVED_TEMPLATE_REQUIRED' },
      data: { nextCheckAt: now },
    });
  }
}

const activeWindow = (date: Date | null, now: Date) => date !== null && +date <= +now && +date > +now - day;

export function reminderChannel(policy: Pick<CommerceReminderPolicy, 'approvedAt' | 'templateName' | 'templateLanguage' |
  'approvedWabaId' | 'approvedPhoneId'>, customer: { lastInboundAt: Date | null; business: {
  waWabaId: string | null; waPhoneNumberId: string | null;
} }, now: Date): 'TEXT' | 'TEMPLATE' | null {
  if (activeWindow(customer.lastInboundAt, now)) return 'TEXT';
  if (policy.approvedAt && +policy.approvedAt > +now - day && policy.templateName && policy.templateLanguage &&
      policy.approvedWabaId === customer.business.waWabaId && policy.approvedPhoneId === customer.business.waPhoneNumberId) return 'TEMPLATE';
  return null;
}

async function reminderCustomer(tx: Tx, businessId: string, customerId: string) {
  return tx.customer.findFirst({ where: { id: customerId, businessId, deletedAt: null, blacklisted: false, waNumberInvalid: false,
    reminderConsent: true, reminderConsentId: { not: null }, business: { active: true, deletedAt: null, deactivatedAt: null } },
  select: { waNumber: true, lastInboundAt: true, reminderConsentId: true,
    business: { select: { waPhoneNumberId: true, waWabaId: true, waAccessToken: true, waConnectionState: true } } } });
}

export async function verifyReminderSend(tx: Tx, sendId: string, data: OutboundJobData, now = new Date()): Promise<string | null> {
  const auth = data.commerceReminder;
  if (!auth || !data.customerId) return 'REMINDER_INVALID';
  const reminder = await tx.commerceReminder.findFirst({ where: { id: auth.id, businessId: data.businessId, sendId, status: 'HANDED_OFF' },
    include: { invoice: { include: { order: { select: { status: true, totalAmount: true } } } } } });
  if (!reminder || reminder.invoice.customerId !== data.customerId) return 'REMINDER_INVALID';
  if (await tx.serviceVisit.findFirst({ where: { invoiceId: reminder.invoiceId, state: { not: 'COMPLETED' } }, select: { appointmentId: true } })) {
    return 'REMINDER_SERVICE_NOT_COMPLETED';
  }
  const policy = await tx.commerceReminderPolicy.findUnique({ where: { businessId: data.businessId } });
  if (!policy?.enabled || policy.maxReminders < reminder.sequence) return 'REMINDER_DISABLED';
  const customer = await reminderCustomer(tx, data.businessId, data.customerId);
  if (!customer || customer.reminderConsentId !== auth.consentId) return 'REMINDER_CONSENT_STALE';
  const channel = reminderChannel(policy, customer, now);
  if ((data.template && (channel !== 'TEMPLATE' || data.template.name !== policy.templateName ||
      data.template.language !== policy.templateLanguage)) || (!data.template && channel !== 'TEXT')) return 'REMINDER_CHANNEL_STALE';
  const { due } = await invoiceAmounts(tx, reminder.invoice);
  return invoiceIsPayable(reminder.invoice) && due.gt(0) && due.toFixed(2) === auth.balance ? null : 'REMINDER_BALANCE_CHANGED';
}

export async function recoverCommerceReminders(now = new Date(), probe?: CommerceRecoveryProbe): Promise<void> {
  const candidates = await prisma.$queryRaw<Array<{ id: string; businessId: string; customerId: string; orderId: string | null }>>`
    SELECT i.id, i."businessId", i."customerId", i."orderId"
    FROM commerce_invoices i JOIN commerce_reminder_policies p ON p."businessId" = i."businessId"
    LEFT JOIN LATERAL (SELECT count(*) AS count, max(r."createdAt") AS latest,
      bool_or(r.status = 'WAITING' OR r.reason IN ('INVOICE_PAID', 'INVOICE_NOT_PAYABLE', 'RELATIONSHIP_ARCHIVED')
        OR s.state IN ('AUTHORIZED', 'QUEUED', 'SENDING', 'RETRY_PENDING', 'REVIEW_REQUIRED', 'PROVIDER_ACCEPTED')) AS paused
      FROM commerce_reminders r LEFT JOIN whatsapp_sends s ON s.id = r."sendId" WHERE r."invoiceId" = i.id) r ON true
    WHERE p.enabled AND i.status = 'ISSUED' AND i."dueAt" <= ${now} AND r.count < p."maxReminders"
      AND NOT EXISTS (SELECT 1 FROM service_visits v WHERE v."invoiceId" = i.id AND v.state <> 'COMPLETED')
      AND NOT coalesce(r.paused, false) AND (r.latest IS NULL OR r.latest + make_interval(days => p."intervalDays") <= ${now})
    ORDER BY i."dueAt", i.id LIMIT 40
  `;
  for (const candidate of candidates) await prisma.$transaction(async (tx) => {
    const invoice = await findInvoiceForPayment(tx, { ...candidate, invoiceId: candidate.id });
    if (!invoice) return;
    const policy = await tx.commerceReminderPolicy.findUnique({ where: { businessId: candidate.businessId } });
    if (!policy?.enabled) return;
    const prior = await tx.commerceReminder.findFirst({ where: { invoiceId: candidate.id }, orderBy: { sequence: 'desc' } });
    if (prior && (prior.sequence >= policy.maxReminders || +prior.createdAt + day * policy.intervalDays > +now)) return;
    await tx.commerceReminder.createMany({ data: { invoiceId: invoice.id, businessId: invoice.businessId,
      sequence: (prior?.sequence ?? 0) + 1, dueAt: now, nextCheckAt: now }, skipDuplicates: true });
  });

  await refreshDueTemplates(now);
  const due = await prisma.commerceReminder.findMany({ where: { status: 'WAITING', nextCheckAt: { lte: now } },
    include: { invoice: { select: { customerId: true, orderId: true, customer: { select: { deletedAt: true } },
      order: { select: { deletedAt: true } } } } }, orderBy: { nextCheckAt: 'asc' }, take: 40 });
  if (due.length) await probe?.('before-reminder-handoff');
  for (const candidate of due) await prisma.$transaction(async (tx) => {
    const { businessId, invoiceId, id } = candidate;
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM commerce_reminders WHERE id = ${id}
      AND status = 'WAITING' AND "nextCheckAt" <= ${now} FOR UPDATE SKIP LOCKED`;
    if (!row) return;
    const cancel = (reason: string) => tx.commerceReminder.update({ where: { id }, data: { status: 'CANCELLED', reason, nextCheckAt: null } });
    const wait = (reason: string) => tx.commerceReminder.update({ where: { id }, data: { reason, nextCheckAt: new Date(+now + 3_600_000) } });
    const scope = { businessId, invoiceId, customerId: candidate.invoice.customerId, orderId: candidate.invoice.orderId };
    if (candidate.invoice.customer.deletedAt || candidate.invoice.order?.deletedAt) return cancel('RELATIONSHIP_ARCHIVED');
    await lockPaymentRelationship(tx, scope, true);
    const invoice = await findInvoiceForPayment(tx, scope);
    if (!invoice || !invoiceIsPayable(invoice)) return cancel('INVOICE_NOT_PAYABLE');
    if (await tx.serviceVisit.findFirst({ where: { invoiceId, state: { not: 'COMPLETED' } }, select: { appointmentId: true } })) {
      return cancel('INVOICE_NOT_PAYABLE');
    }
    const { due: balance } = await invoiceAmounts(tx, invoice);
    if (!balance.gt(0)) return cancel('INVOICE_PAID');
    const policy = await tx.commerceReminderPolicy.findUnique({ where: { businessId } });
    if (!policy?.enabled || policy.maxReminders < candidate.sequence) return cancel('REMINDER_DISABLED');
    const customer = await reminderCustomer(tx, businessId, invoice.customerId);
    if (!customer) return cancel('NO_CURRENT_CONSENT');
    if (+candidate.createdAt + 7 * day <= +now) return cancel('CHANNEL_WAIT_EXPIRED');
    const channel = reminderChannel(policy, customer, now);
    if (!channel) return wait('APPROVED_TEMPLATE_REQUIRED');
    if (!customer.business.waPhoneNumberId || !customer.business.waAccessToken ||
        ['TOKEN_INVALID', 'NUMBER_UNAVAILABLE'].includes(customer.business.waConnectionState)) return wait('WHATSAPP_NOT_CONFIGURED');
    const amount = balance.toFixed(2);
    const body = PAYMENT_REMINDER_TEMPLATE.replace('{{1}}', invoice.reference).replace('{{2}}', amount);
    const sendId = await persistOutboundSend(tx, { businessId, customerId: invoice.customerId, to: customer.waNumber, body,
      commerceReminder: { id, consentId: customer.reminderConsentId!, balance: amount },
      ...(invoice.orderId ? { relatedOrderId: invoice.orderId } : {}),
      ...(channel === 'TEMPLATE' ? { template: { name: policy.templateName!, language: policy.templateLanguage!, parameters: [invoice.reference, amount] } } : {}),
    }, 'invoice-reminder-' + id);
    if (!sendId) throw new Error('Reminder outbox identity conflict');
    return tx.commerceReminder.update({ where: { id }, data: { sendId, status: 'HANDED_OFF', reason: null, nextCheckAt: null } });
  });
}

export function startCommerceReminderRecovery(): () => Promise<void> {
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!active) active = recoverCommerceReminders().catch(() => logger.warn('Commerce reminder recovery will retry'))
      .finally(() => { active = undefined; });
  }, 20_000);
  timer.unref();
  return async () => { clearInterval(timer); await active; };
}
