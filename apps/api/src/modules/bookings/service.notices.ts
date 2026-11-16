import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { persistOutboundSend, type OutboundJobData, type OutboundTemplate } from '../../queues/outbound.queue.js';
import { invoiceAmounts } from '../commerce/commerce.invoices.js';
import type { CommerceRecoveryProbe } from '../commerce/commerce.recovery.js';
import { checkReminderTemplate, PAYMENT_REMINDER_TEMPLATE, reminderChannel } from '../commerce/commerce.reminders.js';
import { lockPaymentRelationship } from '../payments/payment-relationships.js';
import { serviceCharge } from './service.billing.js';
import { dayMs, minuteMs, serviceTime } from './service.calendar.js';
import { snapshotOf } from './service.visits.js';

type Tx = Prisma.TransactionClient;
const serviceTemplate = 'Service appointment {{1}}. {{2}} Reply STOP SERVICE UPDATES to opt out of reminders.';
const eligibility = {
  CONFIRMED: ['CONFIRMED', 'ACKNOWLEDGED'], RESCHEDULED: ['CONFIRMED', 'ACKNOWLEDGED'], UPCOMING: ['CONFIRMED', 'ACKNOWLEDGED'],
  CANCELLED: ['CANCELLED'], NO_SHOW: ['NO_SHOW'], COMPLETE: ['COMPLETED'], FOLLOW_UP: ['COMPLETED'], DEPOSIT: ['HELD'], HOLD_CREATED: ['HELD'],
} as const;

const noticeInclude = { visit: { include: {
  appointment: { select: { reference: true, startsAt: true } }, invoice: true,
} } } satisfies Prisma.ServiceVisitNoticeInclude;
type Notice = Prisma.ServiceVisitNoticeGetPayload<{ include: typeof noticeInclude }>;
type AuthorizedNotice = { body: string; to: string; template?: OutboundTemplate; consentId?: string };

async function currentNotice(tx: Tx, notice: Notice, now: Date): Promise<AuthorizedNotice | string> {
  const { visit, kind } = notice;
  const { businessId, customerId } = visit;
  if (notice.expiresAt <= now) return 'NOTICE_EXPIRED';
  const states = eligibility[kind as keyof typeof eligibility] as readonly string[] | undefined;
  if (notice.scheduleRevision !== visit.scheduleRevision || !states?.includes(visit.state)) return 'NOTICE_STALE';
  const settings = await tx.serviceBusinessSettings.findUnique({ where: { businessId } });
  if (!settings?.enabled || (kind === 'UPCOMING' && !settings.reminderMinutes) ||
    (kind === 'FOLLOW_UP' && !settings.followupEnabled)) return 'NOTICE_DISABLED';
  const customer = await tx.customer.findFirst({ where: { id: customerId, businessId, deletedAt: null, blacklisted: false, waNumberInvalid: false,
    business: { active: true, deletedAt: null, suspendedAt: null, deactivatedAt: null } },
    select: { waNumber: true, lastInboundAt: true, reminderConsent: true, reminderConsentId: true,
      serviceUpdates: true, serviceUpdatesId: true, serviceFollowup: true, serviceFollowupId: true,
      business: { select: { waWabaId: true, waPhoneNumberId: true, waAccessToken: true, waConnectionState: true } } } });
  if (!customer) return 'NOTICE_RELATIONSHIP_UNAVAILABLE';
  if (!customer.business.waPhoneNumberId || !customer.business.waAccessToken ||
      ['TOKEN_INVALID', 'NUMBER_UNAVAILABLE'].includes(customer.business.waConnectionState)) return 'WHATSAPP_NOT_CONFIGURED';
  const { reference, startsAt } = visit.appointment;
  const { timeZone, location } = snapshotOf(visit);
  const time = serviceTime(startsAt, timeZone);
  const inWindow = customer.lastInboundAt && +customer.lastInboundAt <= +now && +customer.lastInboundAt > +now - dayMs;
  if (kind === 'HOLD_CREATED') {
    if (!inWindow) return 'SERVICE_WINDOW_CLOSED';
    if (!visit.holdUntil || visit.holdUntil <= now) return 'NOTICE_STALE';
    const deposit = visit.invoice ? visit.invoice.deposit.minus((await invoiceAmounts(tx, visit.invoice)).verified) : null;
    return { to: customer.waNumber, body: 'Appointment ' + reference + ' is held for ' + time + ' until ' +
      serviceTime(visit.holdUntil, timeZone) + '. Confirmation is pending.' +
      (deposit?.gt(0) ? ' The remaining deposit is GHS ' + deposit.toFixed(2) + '. Ask the team for your payment link.' : '') };
  }
  if (kind === 'DEPOSIT') {
    if (!visit.invoice || !visit.holdUntil || visit.holdUntil <= now) return 'NOTICE_STALE';
    const { verified } = await invoiceAmounts(tx, visit.invoice);
    const balance = visit.invoice.deposit.minus(verified);
    if (!balance.gt(0)) return 'DEPOSIT_ALREADY_PAID';
    if (!customer.reminderConsent || !customer.reminderConsentId) return 'NOTICE_CONSENT_REQUIRED';
    const policy = await tx.commerceReminderPolicy.findUnique({ where: { businessId } });
    if (!inWindow && (!policy?.enabled || reminderChannel(policy, customer, now) !== 'TEMPLATE')) return 'APPROVED_TEMPLATE_REQUIRED';
    const parameters = [visit.invoice.reference, balance.toFixed(2)];
    return { body: PAYMENT_REMINDER_TEMPLATE.replace('{{1}}', parameters[0]!).replace('{{2}}', parameters[1]!),
      consentId: customer.reminderConsentId, to: customer.waNumber, ...(!inWindow && policy ? {
        template: { name: policy.templateName!, language: policy.templateLanguage!, parameters },
      } : {}) };
  }
  if (kind === 'FOLLOW_UP') {
    if (!customer.serviceFollowup || !customer.serviceFollowupId) return 'NOTICE_CONSENT_REQUIRED';
    return inWindow ? { to: customer.waNumber, consentId: customer.serviceFollowupId,
      body: 'Would you like help arranging another service? Reply with the service you need, or STOP SERVICE FOLLOWUPS to opt out.' } :
      'FOLLOWUP_WINDOW_CLOSED';
  }
  const messages: Record<string, string> = {
    CONFIRMED: 'Confirmed for ' + time + ' at ' + location + '.',
    RESCHEDULED: 'Rescheduled to ' + time + ' at ' + location + '.',
    UPCOMING: 'Your upcoming time is ' + time + ' at ' + location + '.',
    CANCELLED: 'This appointment was cancelled. Contact the team for help.',
    NO_SHOW: 'Attendance was recorded as a missed appointment. Contact the team if you need help.',
    COMPLETE: 'The team recorded the service as complete. Contact the team if you need help.',
  };
  const fact = messages[kind]?.replace(/\s+/g, ' ');
  if (!fact) return 'NOTICE_KIND_INVALID';
  const needsConsent = ['UPCOMING', 'NO_SHOW'].includes(kind) || !inWindow;
  if (needsConsent && (!customer.serviceUpdates || !customer.serviceUpdatesId)) return 'NOTICE_CONSENT_REQUIRED';
  if (!inWindow && reminderChannel(settings, customer, now) !== 'TEMPLATE') return 'APPROVED_TEMPLATE_REQUIRED';
  return { body: serviceTemplate.replace('{{1}}', reference).replace('{{2}}', fact), to: customer.waNumber,
    ...(needsConsent && customer.serviceUpdatesId ? { consentId: customer.serviceUpdatesId } : {}), ...(!inWindow ?
      { template: { name: settings.templateName!, language: settings.templateLanguage!, parameters: [reference, fact] } } : {}) };
}

export async function verifyServiceNotice(tx: Tx, sendId: string, data: OutboundJobData, now = new Date()): Promise<string | null> {
  const auth = data.serviceNotice;
  if (!auth || !data.customerId) return 'NOTICE_INVALID';
  const notice = await tx.serviceVisitNotice.findFirst({ where: { id: auth.id, sendId,
    visit: { businessId: data.businessId, customerId: data.customerId } }, include: noticeInclude });
  if (!notice) return 'NOTICE_INVALID';
  const current = await currentNotice(tx, notice, now);
  if (typeof current === 'string') return current;
  const template = current.template && [current.template.name, current.template.language, ...current.template.parameters];
  const sentTemplate = data.template && [data.template.name, data.template.language, ...data.template.parameters];
  if (current.body !== data.body || current.consentId !== auth.consentId || current.to !== data.to ||
    JSON.stringify(template) !== JSON.stringify(sentTemplate)) {
    return 'NOTICE_FACTS_CHANGED';
  }
  return null;
}

export async function verifyServiceCheckout(tx: Tx, data: OutboundJobData, now = new Date()): Promise<string | null> {
  const request = await tx.paymentRequest.findFirst({ where: { id: data.serviceCheckoutId ?? '', businessId: data.businessId,
    customerId: data.customerId ?? '', status: 'PENDING', expiresAt: { gt: now } }, include: { invoice: true } });
  if (!request?.invoice) return 'SERVICE_CHECKOUT_INACTIVE';
  const { verified, due } = await invoiceAmounts(tx, request.invoice);
  const charge = await serviceCharge(tx, request.invoice, verified, due);
  return charge?.charge.eq(request.amount) ? null : 'SERVICE_CHECKOUT_CHANGED';
}

async function refreshServiceTemplates(now: Date): Promise<void> {
  const due = await prisma.$queryRaw<Array<{ businessId: string; templateName: string; templateLanguage: string; revision: number; templateCheckedAt: Date | null }>>`
    SELECT s."businessId", s."templateName", s."templateLanguage", s.revision, s."templateCheckedAt"
    FROM service_business_settings s WHERE s.enabled AND s."templateName" IS NOT NULL AND s."templateLanguage" IS NOT NULL
    AND (s."templateCheckedAt" IS NULL OR s."templateCheckedAt" < ${new Date(+now - 360 * minuteMs)})
    AND EXISTS (SELECT 1 FROM service_visit_notices n JOIN service_visits v ON v."appointmentId" = n."appointmentId"
      WHERE v."businessId" = s."businessId" AND n.reason = 'APPROVED_TEMPLATE_REQUIRED' AND n."expiresAt" > ${now})
    ORDER BY s."templateCheckedAt" NULLS FIRST LIMIT 3
  `;
  for (const row of due) {
    if (!(await prisma.serviceBusinessSettings.updateMany({ where: row, data: { templateCheckedAt: now } })).count) continue;
    const evidence = await checkReminderTemplate(row.businessId, { ...row, enabled: true }, serviceTemplate);
    const saved = await prisma.serviceBusinessSettings.updateMany({ where: { ...row, templateCheckedAt: now }, data: evidence });
    if (saved.count && evidence.approvedAt) await prisma.serviceVisitNotice.updateMany({ where: {
      visit: { businessId: row.businessId }, sendId: null, reason: 'APPROVED_TEMPLATE_REQUIRED', expiresAt: { gt: now },
    }, data: { checkedAt: null } });
  }
}

const retryReasons = ['APPROVED_TEMPLATE_REQUIRED', 'WHATSAPP_NOT_CONFIGURED'];

export async function recoverServiceNotices(now: Date, probe?: CommerceRecoveryProbe): Promise<void> {
  await refreshServiceTemplates(now);
  const due = await prisma.serviceVisitNotice.findMany({ where: { dueAt: { lte: now }, sendId: null, OR: [
    { checkedAt: null },
    { reason: { in: retryReasons }, checkedAt: { lte: new Date(+now - 30 * minuteMs) } },
    { reason: { in: retryReasons }, expiresAt: { lte: now } },
  ] }, select: { id: true, visit: { select: { businessId: true, customerId: true } } },
  orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 20 });
  for (const { id, visit } of due) await prisma.$transaction(async (tx) => {
    await lockPaymentRelationship(tx, visit, true);
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM service_visit_notices WHERE id = ${id}
      AND "sendId" IS NULL AND "dueAt" <= ${now} FOR UPDATE SKIP LOCKED`;
    if (!locked) return;
    const notice = await tx.serviceVisitNotice.findUniqueOrThrow({ where: { id }, include: noticeInclude });
    if (notice.checkedAt && (!retryReasons.includes(notice.reason ?? '') ||
      (notice.expiresAt > now && +notice.checkedAt > +now - 30 * minuteMs))) return;
    if (notice.kind === 'ASSIGNED') {
      const current = notice.visit.scheduleRevision === notice.scheduleRevision && notice.visit.assignedStaffId;
      await tx.serviceVisitNotice.update({ where: { id }, data: { checkedAt: now, reason: current ? 'STAFF_DASHBOARD' : 'NOTICE_STALE' } });
      return;
    }
    const current = await currentNotice(tx, notice, now);
    if (typeof current === 'string') {
      await tx.serviceVisitNotice.update({ where: { id }, data: { checkedAt: now, reason: current } });
      return;
    }
    const sendId = await persistOutboundSend(tx, { businessId: visit.businessId, customerId: visit.customerId,
      to: current.to, body: current.body, ...(current.template ? { template: current.template } : {}),
      serviceNotice: { id, ...(current.consentId ? { consentId: current.consentId } : {}) },
    }, 'service-notice-' + id);
    await tx.serviceVisitNotice.update({ where: { id }, data: { checkedAt: now, sendId, reason: sendId ? null : 'WHATSAPP_NOT_CONFIGURED' } });
    if (sendId) await probe?.('before-service-notice-commit');
  });
}
