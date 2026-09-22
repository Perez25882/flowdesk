import { prisma } from '../../config/database.js';
import { features } from '../../config/env.js';
import { hasGroundableFacts, type BusinessProfile } from '@flowdesk/shared';

/**
 * How far a shop is from being able to use this.
 *
 * Computed from what is actually in the database, never from a "completed
 * onboarding" flag. A flag records that somebody clicked through a wizard; this
 * records whether the product can do its job — and those come apart the first
 * time a WhatsApp token is revoked, an owner deletes their last product, or a
 * trial account is set up by one person and used by another.
 *
 * Because it is derived, a step can go BACK to incomplete, which is the point:
 * a disconnected number should put "connect WhatsApp" in front of the owner
 * again rather than sitting quietly under a green tick.
 */

export type StepId =
  | 'whatsapp'
  | 'shop'
  | 'facts'
  | 'catalogue'
  | 'payouts'
  | 'assistant';

export interface OnboardingStep {
  id: StepId;
  title: string;
  /** What the owner gets out of finishing it — not what the system needs. */
  why: string;
  done: boolean;
  /**
   * Whether the shop can take a customer message at all without this.
   *
   * Only WhatsApp is. Everything else improves the answers; this one decides
   * whether there are any.
   */
  blocking: boolean;
  /** Where in the dashboard it is finished. */
  href: string;
  /** Present when a step that was done has come undone, with the reason. */
  warning?: string;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  /** True once every non-optional step is done — the checklist then disappears. */
  ready: boolean;
}

export async function getOnboardingState(businessId: string): Promise<OnboardingState> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      waPhoneNumberId: true,
      waConnectionState: true,
      waConnectionError: true,
      businessType: true,
      businessProfile: true,
      catalogueMode: true,
      aiAssistMode: true,
      paystackSubaccountCode: true,
    },
  });

  if (!business) {
    return { steps: [], completed: 0, total: 0, ready: false };
  }

  const productCount = await prisma.product.count({
    where: { businessId, deletedAt: null, active: true },
  });

  const profile = (business.businessProfile ?? null) as BusinessProfile | null;
  const connected = Boolean(business.waPhoneNumberId);
  const healthy = business.waConnectionState === 'ACTIVE';

  const steps: OnboardingStep[] = [
    {
      id: 'whatsapp',
      title: 'Connect your WhatsApp number',
      why: 'Nothing reaches you until this is done — no messages, no orders.',
      done: connected && healthy,
      blocking: true,
      href: '/settings?section=business',
      ...(connected && !healthy
        ? {
            warning:
              business.waConnectionError ??
              'Your number needs reconnecting before messages can come through.',
          }
        : {}),
    },
    {
      id: 'shop',
      title: 'Tell us what you sell',
      why: '"Do you have panadol?" is a stock question at a pharmacy and noise at a hardware shop.',
      done: business.businessType !== null,
      blocking: false,
      href: '/settings?section=assistant',
    },
    {
      id: 'facts',
      title: 'Add your hours, delivery and payment details',
      why: 'These are the questions customers ask most, and the only ones that can be answered without you.',
      done: hasGroundableFacts(profile),
      blocking: false,
      href: '/settings?section=assistant',
    },
    {
      // A shop that has told us it keeps no product list has finished this step
      // by saying so. Leaving it permanently unticked would be the product
      // nagging an owner to do something it already knows they will not.
      id: 'catalogue',
      title:
        business.catalogueMode === 'ENQUIRY_LED'
          ? 'Catalogue — not needed for your shop'
          : 'Add what you sell',
      why: 'Prices and stock come from here. Without it the assistant can only take a message.',
      done: business.catalogueMode === 'ENQUIRY_LED' || productCount > 0,
      blocking: false,
      href: '/products',
    },
    {
      id: 'payouts',
      title: 'Set up how you get paid',
      why: 'Lets you send a payment link instead of a momo number and a screenshot to check.',
      done: Boolean(business.paystackSubaccountCode),
      blocking: false,
      href: '/settings?section=payouts',
    },
    {
      id: 'assistant',
      title: 'Turn the assistant on',
      why: 'Until you do, every reply waits for you — which is the thing you came here to stop doing.',
      done: business.aiAssistMode !== 'OFF',
      blocking: false,
      href: '/settings?section=assistant',
    },
  ];

  // A deployment with no Paystack keys cannot offer payouts, and a step nobody
  // can finish is a checklist that never completes.
  const applicable = features.billing ? steps : steps.filter((step) => step.id !== 'payouts');

  const completed = applicable.filter((step) => step.done).length;

  return {
    steps: applicable,
    completed,
    total: applicable.length,
    ready: completed === applicable.length,
  };
}
