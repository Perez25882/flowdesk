import { prisma } from '../../config/database.js';
import { env, features } from '../../config/env.js';
import { hasGroundableFacts, type BusinessProfile } from '@flowdesk/shared';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { profiles } from '../workflows/workflow.contract.js';

type Profile = typeof profiles[number];
type ProviderState = 'NOT_CONFIGURED' | 'INCOMPLETE' | 'LOCAL_VALIDATION' | 'VERIFICATION_PENDING' | 'VERIFIED' | 'ERROR' | 'DISABLED';
type StepId = 'profile' | 'shop' | 'facts' | 'catalogue' | 'hours' | 'policies' | 'team' | 'whatsapp' | 'payouts' | 'assistant';
type Step = { id: StepId; title: string; why: string; done: boolean; blocking: boolean; href: string };
interface OnboardingState {
  profile: Profile | null;
  profileRevision: number;
  steps: Step[];
  completed: number;
  total: number;
  ready: boolean;
  providers: { whatsapp: ProviderState; payments: ProviderState };
}

export async function saveSetupProfile(businessId: string, profile: Profile, revision: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [business] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM businesses WHERE id = ${businessId}
      AND active AND "deletedAt" IS NULL AND "deactivatedAt" IS NULL AND "suspendedAt" IS NULL FOR NO KEY UPDATE`;
    if (!business) throw new NotFoundError('Business not found');
    const saved = revision === 0
      ? await tx.workflowSettings.createMany({ data: { businessId, profile, enabled: false, supportMode: 'OWNER_REVIEW' }, skipDuplicates: true })
      : await tx.workflowSettings.updateMany({ where: { businessId, revision }, data: { profile, revision: { increment: 1 } } });
    if (!saved.count) throw new ConflictError('Your business setup changed. Refresh before saving.');
    if (profile === 'APPOINTMENT' || profile === 'PROFESSIONAL_SERVICES') {
      await tx.business.update({ where: { id: businessId }, data: { bookingsEnabled: true } });
    }
  });
}

export async function getOnboardingState(businessId: string): Promise<OnboardingState> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, ownerName: true, waPhoneNumberId: true, waAccessToken: true, waWebhookVerified: true,
      waConnectionState: true, waConnectionCheckedAt: true, waDisplayNumber: true,
      businessProfile: true, catalogueMode: true, paystackSubaccountCode: true, payoutConnectedAt: true,
      workflowSettings: { select: { profile: true, revision: true, enabled: true } },
      serviceSettings: { select: { enabled: true } }, commercePolicy: { select: { enabled: true } } },
  });
  if (!business) throw new NotFoundError('Business not found');
  const profile = (business.workflowSettings?.profile ?? null) as Profile | null;
  const service = profile === 'APPOINTMENT' || profile === 'PROFESSIONAL_SERVICES';
  const phone = business.waPhoneNumberId;
  const hasMeta = Boolean(phone && business.waAccessToken);
  const [catalogue, staff, inbound, paystack] = await Promise.all([
    service ? prisma.service.count({ where: { businessId, active: true, deletedAt: null, bookingRevision: { gt: 0 } } })
      : prisma.product.count({ where: { businessId, active: true, deletedAt: null } }),
    prisma.staff.count({ where: { businessId, active: true, inviteAcceptedAt: { not: null } } }),
    hasMeta && env.NODE_ENV === 'production' && phone
      ? prisma.$queryRaw<{ id: string }[]>`SELECT r.id FROM whatsapp_text_receipts r
        JOIN whatsapp_phone_ownership o ON o.id = r."ownershipId" AND o."businessId" = r."businessId"
        WHERE r."businessId" = ${businessId} AND r."phoneNumberId" = ${phone} AND o."phoneNumberId" = ${phone}
          AND o."endedAt" IS NULL AND r.kind = 'TEXT' AND r.status = 'COMPLETED' LIMIT 1` : null,
    features.billing && env.NODE_ENV === 'production' && business.payoutConnectedAt
      ? prisma.paystackSettlement.findFirst({ where: { request: { businessId }, createdAt: { gte: business.payoutConnectedAt } }, select: { id: true } }) : null,
  ]);
  const whatsapp: ProviderState = business.waConnectionState === 'TOKEN_INVALID' || business.waConnectionState === 'NUMBER_UNAVAILABLE' ? 'ERROR'
    : !hasMeta ? (phone || business.waAccessToken ? 'INCOMPLETE' : features.whatsapp ? 'NOT_CONFIGURED' : 'DISABLED')
      : env.NODE_ENV !== 'production' && business.waDisplayNumber && business.waConnectionCheckedAt ? 'LOCAL_VALIDATION'
        : business.waWebhookVerified && business.waConnectionState === 'ACTIVE' && business.waDisplayNumber &&
          business.waConnectionCheckedAt && inbound?.length ? 'VERIFIED' : 'VERIFICATION_PENDING';
  const payments: ProviderState = !features.billing ? 'DISABLED' : !business.paystackSubaccountCode ? 'NOT_CONFIGURED'
    : env.NODE_ENV !== 'production' && business.payoutConnectedAt ? 'LOCAL_VALIDATION'
      : paystack && env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_') ? 'VERIFIED' : 'VERIFICATION_PENDING';
  const providerDone = (state: ProviderState) => state === 'VERIFIED' || state === 'DISABLED';
  const steps: Step[] = [
    { id: 'profile', title: 'Choose how you work', why: 'Show the workspaces your business uses.', done: Boolean(profile), blocking: true, href: '/setup#profile' },
    { id: 'shop', title: 'Confirm business details', why: 'Use your existing business name and contact details.', done: Boolean(business.name.trim() && business.ownerName.trim()), blocking: true, href: '/settings?section=business' },
    { id: 'catalogue', title: service ? 'Add services and prices' : 'Add products and prices',
      why: service ? 'Customers book at a configured price and duration.' : 'Give your team current prices and stock.', done: catalogue > 0 || (!service && business.catalogueMode === 'ENQUIRY_LED'),
      blocking: true, href: service ? '/bookings?view=operations#service-setup' : '/products' },
    { id: service ? 'hours' : 'facts', title: service ? 'Set business hours and time zone' : 'Set hours and customer terms',
      why: 'Record the hours, limits and policies your team uses.', done: service ? business.serviceSettings?.enabled === true : hasGroundableFacts(business.businessProfile as BusinessProfile | null),
      blocking: service, href: service ? '/bookings?view=operations#service-setup' : '/settings?section=assistant' },
    { id: 'policies', title: service ? 'Review deposits and booking rules' : 'Review checkout and fulfillment',
      why: 'Choose how work is confirmed and paid for.', done: service ? catalogue > 0 : business.commercePolicy?.enabled === true,
      blocking: false, href: service ? '/bookings?view=operations#service-setup' : '/orders?workspace=quotes' },
    { id: 'team', title: 'Invite your team', why: 'Invite staff when you are ready to assign work.', done: staff > 0, blocking: false, href: '/staff' },
    { id: 'assistant', title: 'Choose assistant permissions', why: 'Control when FlowDesk tracks requests and when a person reviews them.',
      done: business.workflowSettings?.enabled === true, blocking: false, href: '/dashboard?view=work' },
    { id: 'whatsapp', title: 'Customer messaging', why: 'Provider setup is separate from using your local workspace.', done: providerDone(whatsapp), blocking: false, href: '/settings?section=business' },
    { id: 'payouts', title: 'Online payments', why: 'Review the provider setup and its verification status.', done: providerDone(payments), blocking: false, href: '/settings?section=payouts' },
  ];
  return { profile, profileRevision: business.workflowSettings?.revision ?? 0, steps,
    completed: steps.filter(({ done }) => done).length, total: steps.length,
    ready: steps.every(({ blocking, done }) => !blocking || done), providers: { whatsapp, payments } };
}
