/**
 * What a business is, and how it operates.
 *
 * The assistant cannot answer "do you deliver to Tema?" or "are you open on
 * Sunday?" from the order book — those facts exist only in the owner's head.
 * This is where they get written down.
 *
 * Split deliberately into two zones:
 *
 *   Structured facts (this file)  — closed shapes with checkable values. These
 *                                   may ground a reply the assistant sends by
 *                                   itself, because a validator can confirm the
 *                                   answer against them.
 *   Free-text policy notes        — prose. Useful context, but a paraphrase of
 *                                   prose cannot be verified, so it may only
 *                                   ever inform a DRAFT for the owner to check.
 *
 * Kept dependency-free to match `roles.ts` / `sse.ts` / `auth.ts`; the API
 * derives its Zod schema from these constants so the two cannot drift.
 */

export const BUSINESS_TYPES = [
  'PROVISIONS',
  'FOOD',
  'FASHION',
  'BEAUTY',
  'ELECTRONICS',
  'PHARMACY',
  'HARDWARE',
  'AGRICULTURE',
  'WHOLESALE',
  'SERVICES',
  'OTHER',
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Shown in the setup wizard. Plain words, not jargon — the owner picks one. */
export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  PROVISIONS: 'Provisions / groceries',
  FOOD: 'Food, drinks or restaurant',
  FASHION: 'Clothing, shoes or bags',
  BEAUTY: 'Beauty, cosmetics or salon',
  ELECTRONICS: 'Phones or electronics',
  PHARMACY: 'Pharmacy or health',
  HARDWARE: 'Hardware or building materials',
  AGRICULTURE: 'Farm produce or agriculture',
  WHOLESALE: 'Wholesale or distribution',
  SERVICES: 'Services',
  OTHER: 'Something else',
};

export const DAYS_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export const DAY_LABELS: Record<DayOfWeek, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const PAYMENT_METHODS = [
  'MOMO_MTN',
  'MOMO_VODAFONE',
  'MOMO_AIRTELTIGO',
  'CASH',
  'BANK_TRANSFER',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  MOMO_MTN: 'MTN MoMo',
  MOMO_VODAFONE: 'Telecel Cash',
  MOMO_AIRTELTIGO: 'AirtelTigo Money',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
};

/**
 * How the shop handles haggling — a routine part of Ghanaian trade, and the
 * question the assistant is least able to guess at.
 */
export const PRICING_STANCES = ['FIXED', 'SOME_FLEXIBILITY', 'NEGOTIABLE'] as const;
export type PricingStance = (typeof PRICING_STANCES)[number];

export const PRICING_STANCE_LABELS: Record<PricingStance, string> = {
  FIXED: 'Prices are fixed',
  SOME_FLEXIBILITY: 'A little room on bigger orders',
  NEGOTIABLE: 'Prices are negotiable',
};

/** `"08:00"`–`"23:59"`. Stored as a string so it carries no timezone. */
export type TimeOfDay = string;

export interface OpeningHours {
  /** Days the shop is open at all. An absent day answers "are you open Sunday?" with no. */
  days: DayOfWeek[];
  opensAt: TimeOfDay | null;
  closesAt: TimeOfDay | null;
}

/**
 * The checkable facts about a business.
 *
 * Every field is optional: an owner who skips the wizard still gets a working
 * product, the assistant simply declines to answer what it does not know rather
 * than guessing. `null` means "answered, and the answer is none" — distinct from
 * absent, which means "never asked".
 */
export interface BusinessProfile {
  openingHours?: OpeningHours;
  /** Areas served, e.g. ["Tema", "Spintex", "East Legon"]. Empty means no delivery. */
  deliveryAreas?: string[];
  /** Flat fee in GHS. Null when delivery is free or not offered. */
  deliveryFee?: number | null;
  /** Order value above which delivery is free. */
  freeDeliveryAbove?: number | null;
  /** Smallest order the shop will take, in GHS. */
  minimumOrder?: number | null;
  paymentMethods?: PaymentMethod[];
  pricingStance?: PricingStance;
  acceptsReturns?: boolean;
  returnWindowDays?: number | null;
}

/**
 * The guided setup questions, in the order the wizard asks them.
 *
 * Held here rather than in the dashboard so the question set, the stored shape
 * and the facts the assistant is allowed to cite are one definition — the same
 * reason the reply-template catalogue is served by the API.
 */
export interface ProfileQuestion {
  field: keyof BusinessProfile;
  question: string;
  /** Why it is worth answering, shown under the question. */
  hint: string;
}

export const PROFILE_QUESTIONS: readonly ProfileQuestion[] = [
  {
    field: 'openingHours',
    question: 'When are you open?',
    hint: 'So customers asking at 10pm are told when you reopen, instead of being left waiting.',
  },
  {
    field: 'deliveryAreas',
    question: 'Where do you deliver?',
    hint: 'Lets the assistant answer "do you deliver to Tema?" without checking with you.',
  },
  {
    field: 'deliveryFee',
    question: 'What do you charge for delivery?',
    hint: 'Quoted exactly as you enter it. Leave empty if delivery is free.',
  },
  {
    field: 'freeDeliveryAbove',
    question: 'Is delivery free above a certain amount?',
    hint: 'Often turns a small order into a bigger one.',
  },
  {
    field: 'minimumOrder',
    question: 'Do you have a minimum order?',
    hint: 'Saves the back-and-forth on orders you would decline anyway.',
  },
  {
    field: 'paymentMethods',
    question: 'How can customers pay you?',
    hint: 'The most common question after price.',
  },
  {
    field: 'pricingStance',
    question: 'Can customers negotiate on price?',
    hint: 'Tells the assistant whether to hold your price or bring you in to decide.',
  },
  {
    field: 'acceptsReturns',
    question: 'Do you accept returns?',
    hint: 'Answered plainly, so a complaint does not sit unanswered until you see it.',
  },
];

/** True when nothing has been filled in, so the UI can prompt for setup. */
export function isProfileEmpty(profile: BusinessProfile | null | undefined): boolean {
  if (!profile) return true;
  return Object.values(profile).every(
    (value) =>
      value === undefined ||
      value === null ||
      (Array.isArray(value) && value.length === 0),
  );
}

/** How many of the guided questions have an answer — drives a progress hint. */
export function countAnsweredQuestions(profile: BusinessProfile | null | undefined): number {
  if (!profile) return 0;

  return PROFILE_QUESTIONS.filter((q) => {
    const value = profile[q.field];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (q.field === 'openingHours') return (value as OpeningHours).days.length > 0;
    return true;
  }).length;
}

/**
 * Whether a business has enough recorded to let the assistant send answers on
 * its own.
 *
 * Auto-send is only safe where there are facts to check an answer against, so a
 * shop that skipped setup stays in draft mode however it is configured.
 */
export function hasGroundableFacts(profile: BusinessProfile | null | undefined): boolean {
  return countAnsweredQuestions(profile) > 0;
}

/**
 * How much the assistant may do without the owner.
 *
 * Per-tenant, and the kill switch if answers start going wrong for one business
 * without having to disable the feature for everyone.
 */
export const AI_ASSIST_MODES = ['OFF', 'DRAFT_ONLY', 'GROUNDED_AUTO'] as const;
export type AiAssistMode = (typeof AI_ASSIST_MODES)[number];

export const AI_ASSIST_MODE_LABELS: Record<AiAssistMode, string> = {
  OFF: 'Off — use the fixed replies only',
  DRAFT_ONLY: 'Write replies for me to approve',
  GROUNDED_AUTO: 'Answer directly when it is sure, otherwise ask me',
};

/**
 * Whether a shop keeps a product list in Flowdesk at all.
 *
 * Not every business can. A boutique selling second-hand clothes has stock that
 * turns over daily and no two pieces alike; a customer asks "do you have baggy
 * jeans?" and the only person who can answer is the owner, looking at her rail.
 * Requiring a catalogue before the product is useful would ask that shop for a
 * day of data entry to unlock a feature they never wanted.
 *
 * Deliberately a stated setting rather than "is the products table empty".
 * A shop that has not added products YET is not the same as a shop that never
 * will, and guessing wrong changes what every one of their customers is told.
 */
export const CATALOGUE_MODES = ['CATALOGUE', 'ENQUIRY_LED'] as const;
export type CatalogueMode = (typeof CATALOGUE_MODES)[number];

export const CATALOGUE_MODE_LABELS: Record<CatalogueMode, string> = {
  CATALOGUE: 'I add my products and prices in Flowdesk',
  ENQUIRY_LED: 'Customers ask and I tell them what I have',
};
