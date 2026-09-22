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

/**
 * Ghana's sixteen regions.
 *
 * A closed list because it is genuinely closed — the last change was the 2018
 * referendum that split six new regions out of four, and a region is not
 * something a shop owner should be typing free-hand when the whole point is
 * that "Ashanti" and "ashanti region" have to match each other. Towns and
 * areas below it stay free text, because nobody can enumerate every
 * neighbourhood in Accra and pretending otherwise would block real addresses.
 */
export const GHANA_REGIONS = [
  'Greater Accra',
  'Ashanti',
  'Western',
  'Western North',
  'Central',
  'Eastern',
  'Volta',
  'Oti',
  'Northern',
  'Savannah',
  'North East',
  'Upper East',
  'Upper West',
  'Bono',
  'Bono East',
  'Ahafo',
] as const;

export type GhanaRegion = (typeof GHANA_REGIONS)[number];

/**
 * One place the shop delivers to, and what it costs to get there.
 *
 * Three levels because a single flat fee is wrong in both directions at once:
 * GHS 20 across Accra overcharges the customer two streets away and loses money
 * on the one in Kasoa, and the owner's answer to "how much to bring it?" has
 * always depended on where. Region narrows it, town is what a customer actually
 * says, and area is the precision a rider needs — optional, because plenty of
 * shops price by town and no further.
 *
 * The fee is per zone and quoted exactly. Nothing here is interpolated or
 * estimated: a zone that is not listed is a question for the owner, not a guess.
 */
export interface DeliveryZone {
  region: GhanaRegion;
  /** What a customer would call it: "Tema", "Kasoa", "Madina". */
  town: string;
  /** Narrower still: "Community 1", "Adenta Housing Down". Null prices the whole town. */
  area?: string | null;
  /** In GHS. Zero means delivery there is free. */
  fee: number;
  /** How long it takes, in the owner's own words: "same day", "1-2 days". */
  eta?: string | null;
}

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
  /**
   * Where the shop delivers, priced per zone.
   *
   * Supersedes the flat `deliveryFee` without replacing it: a shop that only
   * ever set one fee keeps working exactly as before, and the flat fee is still
   * what answers a customer whose area is not listed. When both exist, the zone
   * wins, because it is the more specific answer to the question asked.
   */
  deliveryZones?: DeliveryZone[];
  /**
   * A link to the shop on a map — Google Maps, or a Ghana Post GPS code.
   *
   * Sent to a customer who asks where the shop is, which is a question no
   * amount of prose answers well. Validated as a URL or a GhanaPost code so the
   * assistant is never handed something it would paste as a broken link.
   */
  locationUrl?: string | null;
  /** How to find it in words: "Behind Melcom, Spintex Road". */
  locationDescription?: string | null;
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
    field: 'deliveryZones',
    question: 'What do you charge to deliver to each place?',
    hint: 'One flat fee overcharges the customer nearby and loses money on the far one.',
  },
  {
    field: 'locationUrl',
    question: 'Where is the shop?',
    hint: 'A map link, sent to anyone who asks where to find you.',
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
export const AI_ASSIST_MODES = ['OFF', 'DRAFT_ONLY', 'GROUNDED_AUTO', 'AUTONOMOUS'] as const;
export type AiAssistMode = (typeof AI_ASSIST_MODES)[number];

export const AI_ASSIST_MODE_LABELS: Record<AiAssistMode, string> = {
  OFF: 'Off — use the fixed replies only',
  DRAFT_ONLY: 'Write replies for me to approve',
  GROUNDED_AUTO: 'Answer directly when it is sure, otherwise ask me',
  AUTONOMOUS: 'Run my conversations on its own',
};

/**
 * What each mode actually does, in the owner's terms.
 *
 * Separate from the label because the label is a menu item and this is the
 * consequence. AUTONOMOUS in particular is not a confidence dial and reads like
 * one, so its description says plainly what it stops checking.
 */
export const AI_ASSIST_MODE_DESCRIPTIONS: Record<AiAssistMode, string> = {
  OFF: 'Customers get your fixed replies only. Nothing is written for you.',
  DRAFT_ONLY: 'Every reply waits for you to read and send it. Nothing goes out on its own.',
  GROUNDED_AUTO:
    'Answers questions it can check against your catalogue and your saved details. Anything it cannot check comes to you first.',
  AUTONOMOUS:
    'Answers everything, takes orders and sends payment links without showing you first — including answers it could not check against anything you have recorded.',
};

/** Modes that send messages to customers without the owner reading them. */
export function sendsWithoutReview(mode: AiAssistMode): boolean {
  return mode === 'GROUNDED_AUTO' || mode === 'AUTONOMOUS';
}

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

/**
 * The fee for delivering to a place the customer named.
 *
 * Matching is deliberately generous on spelling and strict on meaning. A
 * customer types "tema comm 1" and "Tema Community 1" for the same street, so
 * the comparison is case- and whitespace-insensitive and tolerates the area
 * being named without its town. What it will NOT do is guess: an unmatched
 * place returns null, and null is the assistant's cue to ask the owner rather
 * than to quote a number nobody set.
 *
 * The most specific match wins, so a shop that prices Tema at GHS 20 and Tema
 * Community 1 at GHS 15 quotes 15 to someone who said Community 1.
 */
export function findDeliveryZone(
  zones: DeliveryZone[] | undefined,
  place: string,
): DeliveryZone | null {
  if (!zones || zones.length === 0) return null;

  const needle = normalizePlace(place);
  if (!needle) return null;

  let best: DeliveryZone | null = null;
  let bestScore = 0;

  for (const zone of zones) {
    const town = normalizePlace(zone.town);
    const area = zone.area ? normalizePlace(zone.area) : '';

    // An area match is worth more than a town match, and a match on the full
    // "town area" string more than either — that is what "most specific wins"
    // means in practice.
    let score = 0;
    if (area && (needle.includes(area) || area.includes(needle))) score = 3;
    if (town && area && needle.includes(town) && needle.includes(area)) score = 4;
    if (score === 0 && town && (needle.includes(town) || town.includes(needle))) {
      // A town-wide zone answers a bare town name; a zone scoped to one area
      // does not, because the customer has not said they are in that area.
      score = area ? 1 : 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = zone;
    }
  }

  return best;
}

function normalizePlace(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    // "comm 1" and "community 1" are the same place to everyone in Tema.
    .replace(/\bcomm\b/g, 'community')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every place the shop delivers to, as a customer would say it. */
export function deliveryPlaceNames(profile: BusinessProfile | null | undefined): string[] {
  if (!profile) return [];

  const names = new Set<string>();
  for (const area of profile.deliveryAreas ?? []) names.add(area);
  for (const zone of profile.deliveryZones ?? []) {
    names.add(zone.area ? `${zone.town} — ${zone.area}` : zone.town);
  }

  return [...names];
}
