import type { CommerceCaseKind, Prisma, Workflow } from '@prisma/client';
import { persistOutboundSend } from '../../queues/outbound.queue.js';
import { isAppError } from '../../utils/errors.js';
import { invoiceAmounts } from '../commerce/commerce.invoices.js';
import { loadCommerceSource } from '../commerce/commerce.quotes.js';
import { lockPaymentRelationship } from '../payments/payment-relationships.js';
import { type BusinessEvent } from '../workflows/workflow.contract.js';
import { bookingInput } from './service.contract.js';
import { lockServiceBusiness, managedService, managedSlots } from './service.schedule.js';
import { dayMs, serviceTime } from './service.calendar.js';
import { closedVisits, createServiceVisit, snapshotOf } from './service.visits.js';
import { manualServiceSource } from './service.workflow-store.js';
import type { CommerceRecoveryProbe } from '../commerce/commerce.recovery.js';

type Tx = Prisma.TransactionClient;
type Source = Awaited<ReturnType<typeof loadCommerceSource>>;
const uuid = '[a-f0-9-]{36}';

function progress(key: string, reason: string, state: 'WAITING_STAFF' | 'WAITING_CUSTOMER' | 'WAITING_PROVIDER',
  operator: BusinessEvent['operator'], facts: Prisma.InputJsonObject, appointmentId?: string): BusinessEvent {
  return { type: 'SERVICE_PROGRESS', key, reason, state, operator, facts, ...(appointmentId ? { links: { appointmentId } } : {}) };
}

function done(key: string, reason: string, operator: BusinessEvent['operator'], facts: Prisma.InputJsonObject): BusinessEvent {
  return { type: 'SERVICE_DONE', key, reason, state: 'COMPLETED', operator, facts };
}

async function replyToService(tx: Tx, row: Workflow, source: Source, key: string, body: string, now: Date): Promise<string | null> {
  const customer = await tx.customer.findFirst({ where: { id: row.customerId, businessId: row.businessId,
    deletedAt: null, blacklisted: false, waNumberInvalid: false, lastInboundAt: { gt: new Date(+now - dayMs) } }, select: { waNumber: true } });
  if (!customer) return null;
  const send = await tx.whatsAppSend.findUnique({ where: { businessId_eventKey: { businessId: row.businessId, eventKey: key } }, select: { id: true } });
  return send?.id ?? persistOutboundSend(tx, { businessId: row.businessId, customerId: row.customerId,
    to: customer.waNumber, body, inReplyToMessageId: source.id, suppressIfOwnerRepliedSince: source.createdAt.toISOString() }, key);
}

async function observeReply(tx: Tx, row: Workflow, id: string | null, source: Pick<Source, 'id'>): Promise<BusinessEvent | null> {
  const send = id && await tx.whatsAppSend.findFirst({ where: { id, businessId: row.businessId }, select: {
    state: true, deliveredAt: true, readAt: true, providerMessageId: true,
  } });
  if (!send || ['FAILED', 'REVIEW_REQUIRED'].includes(send.state)) return {
    type: 'REVIEW', key: 'service:reply:review:' + source.id, reason: 'SERVICE_REPLY_REQUIRES_REVIEW', state: 'REVIEW_REQUIRED', operator: 'CARE',
  };
  if ((send.deliveredAt || send.readAt) && send.providerMessageId) return done('service:reply:delivered:' + id,
    'SERVICE_REPLY_DELIVERED', 'CARE', { sendId: id, sourceId: source.id });
  if (row.sendId === id) return null;
  const event = progress('service:reply:pending:' + id, 'SERVICE_REPLY_WAITING_FOR_PROVIDER', 'WAITING_PROVIDER', 'CARE', { sendId: id });
  return event && id ? { ...event, links: { sendId: id } } : event;
}

async function openServiceCase(tx: Tx, row: Workflow, source: Source, kind: CommerceCaseKind, appointmentId: string | null, now: Date) {
  const relation = { businessId: row.businessId, customerId: row.customerId, sourceId: source.id };
  const item = await tx.commerceCase.upsert({ where: { businessId_sourceId: { businessId: row.businessId, sourceId: source.id } },
    update: {}, create: { ...relation, kind, history: { create: { state: 'OPEN', revision: 0 } } } });
  await tx.serviceLead.upsert({ where: { businessId_sourceId: { businessId: row.businessId, sourceId: source.id } }, update: {},
    create: { ...relation, workflowId: row.id, status: 'CARE', caseId: item.id, requirements: source.body?.slice(0, 600) ?? null,
      evidence: [{ sourceId: source.id, appointmentId }] } });
  if (item.state === 'RESOLVED') return done('service:case:resolved:' + item.id, 'SERVICE_CASE_RESOLVED', 'CARE', { caseId: item.id });
  await replyToService(tx, row, source, 'service-care-' + item.id, 'Your request is with the team. Case ' + item.id +
    '. When the issue is resolved, reply RESOLVED ' + item.id + '.', now);
  return progress('service:case:' + item.id + ':' + item.revision, 'SERVICE_CASE_OPEN', item.state === 'WAITING' ? 'WAITING_CUSTOMER' : 'WAITING_STAFF',
    'CARE', { caseId: item.id, appointmentId, caseState: item.state });
}

async function reconciliation(tx: Tx, row: Workflow, lead: {
  id: string; revision: number; status: string; serviceId: string | null; followupAt: Date | null;
} | null, now: Date) {
  const where = lead ? { leadId: lead.id } : row.appointmentId ? { appointmentId: row.appointmentId } : null;
  const visit = where && await tx.serviceVisit.findUnique({ where, include: { notices: true } });
  if (visit && visit.businessId === row.businessId && visit.customerId === row.customerId) {
    const facts = { appointmentId: visit.appointmentId, leadId: lead?.id ?? null, state: visit.state, invoiceId: visit.invoiceId };
    if ((closedVisits as readonly string[]).includes(visit.state)) return {
      type: visit.state === 'CANCELLED' ? 'CANCELLED' : 'REVIEW', key: 'service:closed:' + visit.appointmentId,
      state: visit.state === 'CANCELLED' ? 'CANCELLED' : 'REVIEW_REQUIRED', operator: 'CARE', reason: 'SERVICE_' + visit.state, facts,
    } satisfies BusinessEvent;
    if (visit.state === 'COMPLETED') {
      const completion = visit.notices.find((notice) => notice.kind === 'COMPLETE');
      if (completion?.sendId) {
        const result = await tx.whatsAppSend.findFirst({ where: { id: completion.sendId, businessId: row.businessId },
          select: { state: true, deliveredAt: true, readAt: true, providerMessageId: true } });
        if ((result?.deliveredAt || result?.readAt) && result.providerMessageId) return done('service:completed:' + visit.appointmentId,
          'SERVICE_COMPLETION_DELIVERED', 'CARE', { ...facts, sendId: completion.sendId });
        if (result && ['FAILED', 'REVIEW_REQUIRED'].includes(result.state)) return {
          type: 'REVIEW', state: 'REVIEW_REQUIRED', operator: 'CARE', reason: 'SERVICE_COMPLETION_NOTICE_REQUIRES_REVIEW',
          key: 'service:completion:review:' + visit.appointmentId, facts,
        } satisfies BusinessEvent;
      }
      if (!completion || completion.expiresAt <= now) return {
        type: 'REVIEW', state: 'REVIEW_REQUIRED', operator: 'CARE', reason: 'SERVICE_COMPLETION_NOTICE_EXPIRED',
        key: 'service:completion:expired:' + visit.appointmentId, facts,
      } satisfies BusinessEvent;
    }
    const state = visit.state === 'HELD' && visit.approvalRequired && !visit.approvedAt ? 'WAITING_STAFF'
      : ['HELD', 'COMPLETED'].includes(visit.state) ? 'WAITING_PROVIDER' : 'WAITING_STAFF';
    return progress('service:visit:' + visit.appointmentId + ':' + visit.revision, 'SERVICE_' + visit.state, state,
      visit.state === 'HELD' && state === 'WAITING_PROVIDER' ? 'PAYMENTS' : visit.state === 'COMPLETED' ? 'CARE' : 'BOOKINGS', facts,
      row.appointmentId === visit.appointmentId ? undefined : visit.appointmentId);
  }
  if (!lead) return { type: 'REVIEW', key: 'service:visit:missing:' + row.id, reason: 'SERVICE_VISIT_UNAVAILABLE',
    state: 'REVIEW_REQUIRED', operator: 'BOOKINGS' } satisfies BusinessEvent;
  if (['DECLINED', 'LOST', 'UNQUALIFIED'].includes(lead.status)) return done('service:lead:closed:' + lead.id, 'SERVICE_LEAD_' + lead.status, 'BOOKINGS', { leadId: lead.id });
  if (lead.followupAt && lead.followupAt <= now) return progress('service:lead:followup:' + lead.id + ':' + lead.revision,
    'SERVICE_LEAD_FOLLOWUP_DUE', 'WAITING_STAFF', 'BOOKINGS', { leadId: lead.id, followupAt: lead.followupAt.toISOString() });
  return progress('service:lead:' + lead.id + ':' + lead.revision, 'SERVICE_LEAD_' + lead.status,
    lead.status === 'QUALIFIED' ? 'WAITING_CUSTOMER' : 'WAITING_STAFF', 'BOOKINGS', { leadId: lead.id, serviceId: lead.serviceId });
}

export async function observeServiceWorkflow(tx: Tx, row: Workflow, now: Date, probe?: CommerceRecoveryProbe): Promise<BusinessEvent | null> {
  if (row.sourceId.startsWith(manualServiceSource)) {
    const lead = await tx.serviceLead.findUnique({ where: { workflowId: row.id } });
    return reconciliation(tx, row, lead, now);
  }
  if (row.sendId) return observeReply(tx, row, row.sendId, { id: row.sourceId });
  const receipt = await tx.whatsAppTextReceipt.findUnique({ where: { messageId: row.sourceId }, select: { status: true } });
  if (receipt?.status === 'FAILED') return { type: 'REVIEW', key: 'service:receipt:' + row.sourceId, reason: 'SERVICE_SOURCE_REJECTED',
    state: 'REVIEW_REQUIRED', operator: 'CARE' };
  if (receipt && receipt.status !== 'COMPLETED') return null;
  await tx.$executeRawUnsafe('SAVEPOINT observe_service_command');
  try {
    const scope = { businessId: row.businessId, customerId: row.customerId };
    await lockPaymentRelationship(tx, scope);
    await lockServiceBusiness(tx, row.businessId);
    const source = await loadCommerceSource(tx, scope, row.sourceId);
    const body = source.body?.trim() ?? '';
    const existing = await tx.serviceLead.findUnique({ where: { workflowId: row.id } });
    if (existing && existing.status !== 'CARE') return await reconciliation(tx, row, existing, now);
    if (/^(?:START|STOP) (?:SERVICE UPDATES|SERVICE FOLLOWUPS|PAYMENT REMINDERS)$/i.test(body)) {
      return done('service:preference:' + source.id, 'SERVICE_COMMUNICATION_PREFERENCE_RECORDED', 'CARE', { sourceId: source.id });
    }
    const book = body.match(new RegExp('^BOOK (' + uuid + ') (\\S+) (\\d+) (\\d+)$', 'i'));
    const times = body.match(new RegExp('^TIMES (' + uuid + ')(?: (\\S+))?$', 'i'));
    if (book || times) {
      const leadId = (book ?? times)![1]!.toLowerCase();
      const lead = await tx.serviceLead.findFirst({ where: { id: leadId, ...scope, status: { in: ['QUALIFIED', 'BOOKED'] } } });
      if (!lead?.serviceId) return observeReply(tx, row, await replyToService(tx, row, source, 'service-reply-' + source.id,
        'A qualified service request is required. Please contact the team.', now), source);
      if (book) {
        const input = bookingInput.parse({ customerId: scope.customerId, serviceId: lead.serviceId, startsAt: book[2],
          serviceRevision: Number(book[3]), settingsRevision: Number(book[4]), leadId, requestKey: 'inbound:' + source.id });
        const visit = await createServiceVisit(tx, row.businessId, input, null, now);
        await probe?.('before-service-reservation-commit');
        return done('service:booking:' + visit.appointmentId, 'SERVICE_BOOKING_REQUEST_ATTACHED', 'BOOKINGS',
          { appointmentId: visit.appointmentId, parentWorkflowId: lead.workflowId, leadId, state: visit.state });
      }
      const from = times?.[2] ? new Date(times[2]) : now;
      if (!Number.isFinite(+from) || lead.status !== 'QUALIFIED') return observeReply(tx, row, await replyToService(tx, row, source,
        'service-reply-' + source.id, 'Please contact the team for current service options.', now), source);
      const quote = await managedSlots(tx, row.businessId, lead.serviceId, from, 7, 1, now);
      const { service, rules } = await managedService(tx, row.businessId, lead.serviceId);
      const bodyReply = quote.slots.length ? [service.name + ' — GHS ' + quote.terms.total + ' for ' + quote.terms.durationMinutes + ' minutes',
        ...(Number(quote.terms.deposit) > 0 ? ['Deposit before confirmation: GHS ' + quote.terms.deposit + '.'] : []),
        ...(quote.terms.approvalRequired ? ['The team must approve the booking.'] : []),
        ...(rules.instructions ? [rules.instructions] : []), 'Reply with one of these booking commands:',
        ...quote.slots.slice(0, 4).map((slot) => slot.localTime + '\nBOOK ' + lead.id + ' ' + slot.startsAt.toISOString() +
          ' ' + quote.serviceRevision + ' ' + quote.settingsRevision)].join('\n') : 'No matching time is available. Please contact the team.';
      return observeReply(tx, row, await replyToService(tx, row, source, 'service-reply-' + source.id, bodyReply, now), source);
    }
    const support = body.match(/^(STATUS|PAYMENT|CANCEL|RESCHEDULE|COMPLAINT|MISSED|QUALITY|STAFF) (FD-A-S[A-F0-9]{32})(?:\s+([\s\S]+))?$/i);
    if (support) {
      const command = support[1]!.toUpperCase();
      const visit = await tx.serviceVisit.findFirst({ where: { ...scope, appointment: { reference: support[2]!.toUpperCase() } },
        include: { appointment: true, invoice: true } });
      if (visit && !['STATUS', 'PAYMENT'].includes(command)) return await openServiceCase(tx, row, source,
        command === 'CANCEL' ? 'CANCELLATION' : 'COMPLAINT', visit.appointmentId, now);
      const amounts = visit?.invoice && await invoiceAmounts(tx, visit.invoice);
      const reply = !visit ? 'That appointment is unavailable. Please check your reference.'
        : command === 'PAYMENT' ? (amounts ? visit.appointment.reference + ' verified balance due: GHS ' + amounts.due.toFixed(2) + '.' :
          'There is no invoice for ' + visit.appointment.reference + '.')
          : visit.appointment.reference + ' is ' + visit.state.toLowerCase().replaceAll('_', ' ') + '. Scheduled for ' +
            serviceTime(visit.appointment.startsAt, snapshotOf(visit).timeZone) + '.';
      return observeReply(tx, row, await replyToService(tx, row, source, 'service-reply-' + source.id, reply, now), source);
    }
    const resolution = body.match(new RegExp('^RESOLVED (' + uuid + ')$', 'i'));
    if (resolution) {
      const item = await tx.commerceCase.findFirst({ where: { id: resolution[1]!.toLowerCase(), ...scope }, select: { id: true } });
      return done('service:case:customer-evidence:' + source.id, item ? 'SERVICE_CASE_CUSTOMER_EVIDENCE' : 'SERVICE_CASE_UNAVAILABLE',
        'CARE', { sourceId: source.id, caseId: item?.id ?? null });
    }
    if (existing?.status === 'CARE' || /^(?:COMPLAINT|CANCEL|RESCHEDULE|MISSED|QUALITY|STAFF|PAYMENT)\b/i.test(body)) {
      return await openServiceCase(tx, row, source, /^CANCEL\b/i.test(body) ? 'CANCELLATION' : 'COMPLAINT', null, now);
    }
    const request = body.match(/^SERVICE\s+([^|]{1,120})(?:\s*\|\s*([\s\S]{1,600}))?$/i);
    const requested = request && await tx.service.findMany({ where: { businessId: row.businessId, active: true,
      deletedAt: null, bookingRevision: { gt: 0 }, name: { equals: request[1]!.trim(), mode: 'insensitive' } }, select: { id: true }, take: 2 });
    const serviceId = requested && requested.length === 1 ? requested[0]!.id : null;
    const lead = await tx.serviceLead.create({ data: { ...scope, workflowId: row.id, sourceId: source.id, serviceId,
      requirements: (request?.[2] ?? body).slice(0, 600), evidence: [{ sourceId: source.id }] } });
    const questions = serviceId ? (await managedService(tx, row.businessId, serviceId)).rules.questions : [];
    await replyToService(tx, row, source, 'service-lead-' + lead.id, ['The team received your service inquiry ' + lead.id + '.',
      ...questions, ...(serviceId ? ['After qualification, reply TIMES ' + lead.id + ' for available appointments.'] :
        ['Please provide the service you need and your preferred timing.'])].join('\n'), now);
    return reconciliation(tx, row, lead, now);
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT observe_service_command');
    if (!isAppError(error) && (error as Error).name !== 'ZodError') throw error;
    return { type: 'REVIEW', key: 'service:validation:' + row.sourceId, reason: 'SERVICE_REQUEST_REQUIRES_REVIEW',
      state: 'REVIEW_REQUIRED', operator: 'BOOKINGS' };
  }
}
