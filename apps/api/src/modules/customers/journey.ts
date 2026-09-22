/**
 * How far a customer got, and where they stopped.
 *
 * A shop with a hundred conversations and eight orders knows it is losing
 * ninety-two of them and has no idea where. This turns each conversation into a
 * position on a short path — asked, wanted, billed, paid — so the losses can be
 * counted at the step they happen on.
 *
 * Pure. The rows come from `journey.service.ts`; every judgement about what they
 * mean is here, where a test can disagree with it.
 *
 * The step is the FURTHEST point reached, not the most recent event. Someone
 * who pays and then asks another question has not fallen back to "asked", and a
 * timeline that said so would report a paying customer as a lost one.
 */

export const JOURNEY_STAGES = ['greeted', 'asked', 'wanted', 'billed', 'paid'] as const;

export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export interface JourneyInput {
  customerId: string;
  /** Every intent seen on this customer's inbound messages. */
  intents: string[];
  ordersPlaced: number;
  /** Payment links sent to them, whatever became of them. */
  paymentLinksSent: number;
  paymentsSettled: number;
  lastActivityAt: Date | null;
}

export interface JourneyPosition {
  customerId: string;
  stage: JourneyStage;
  /** Days spent sitting at this stage with nothing further happening. */
  daysStalled: number | null;
  /** True when this is the end of the path rather than a stall. */
  complete: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function positionFor(input: JourneyInput, now: Date = new Date()): JourneyPosition {
  const stage = furthestStage(input);
  const daysStalled = input.lastActivityAt
    ? Math.max(0, Math.floor((now.getTime() - input.lastActivityAt.getTime()) / DAY))
    : null;

  return {
    customerId: input.customerId,
    stage,
    daysStalled,
    complete: stage === 'paid',
  };
}

function furthestStage(input: JourneyInput): JourneyStage {
  if (input.paymentsSettled > 0) return 'paid';
  if (input.paymentLinksSent > 0) return 'billed';
  if (input.ordersPlaced > 0) return 'wanted';

  // An order intent without an order row is a customer who said they wanted
  // something and never got one raised. That is a different — and more
  // damning — failure than never asking, so it earns its own step.
  if (input.intents.includes('ORDER')) return 'wanted';
  if (input.intents.some((intent) => intent === 'INQUIRY' || intent === 'STATUS_CHECK')) {
    return 'asked';
  }

  return 'greeted';
}

export interface FunnelStep {
  stage: JourneyStage;
  /** How many customers reached this step at all. */
  reached: number;
  /** How many stopped here and went no further. */
  stoppedHere: number;
}

/**
 * The funnel, counted as "reached" rather than "is at".
 *
 * `reached` is cumulative from the far end, so the numbers only ever fall as
 * you go down the list and the drop between two rows IS the loss. Counting each
 * step's occupants instead produces a chart where a good month — everyone
 * paying — looks like a collapse at every earlier step.
 */
export function buildFunnel(positions: JourneyPosition[]): FunnelStep[] {
  const stoppedAt = new Map<JourneyStage, number>();
  for (const stage of JOURNEY_STAGES) stoppedAt.set(stage, 0);
  for (const position of positions) {
    stoppedAt.set(position.stage, (stoppedAt.get(position.stage) ?? 0) + 1);
  }

  let cumulative = 0;

  // Walked backwards, so each step's `reached` includes everyone past it.
  return [...JOURNEY_STAGES]
    .reverse()
    .map((stage) => {
      cumulative += stoppedAt.get(stage) ?? 0;
      return { stage, reached: cumulative, stoppedHere: stoppedAt.get(stage) ?? 0 };
    })
    .reverse();
}

/**
 * The step losing the most people.
 *
 * Measured as the biggest fall between one step and the next, not the step with
 * most people parked on it. The first step always holds the most people in any
 * shop, and reporting it every month would be true, useless, and would teach an
 * owner to stop reading.
 *
 * Null when there is not enough traffic for a drop to mean anything. Ten
 * conversations produce a "70% drop-off" that is three people.
 */
export function worstDropOff(funnel: FunnelStep[], minimumTraffic = 20): {
  from: JourneyStage;
  to: JourneyStage;
  lost: number;
  rate: number;
} | null {
  const top = funnel[0];
  if (!top || top.reached < minimumTraffic) return null;

  let worst: { from: JourneyStage; to: JourneyStage; lost: number; rate: number } | null = null;

  for (let index = 0; index < funnel.length - 1; index += 1) {
    const from = funnel[index]!;
    const to = funnel[index + 1]!;
    if (from.reached === 0) continue;

    const lost = from.reached - to.reached;
    const rate = lost / from.reached;

    if (lost > 0 && (worst === null || lost > worst.lost)) {
      worst = { from: from.stage, to: to.stage, lost, rate };
    }
  }

  return worst;
}

export const STAGE_LABELS: Record<JourneyStage, string> = {
  greeted: 'Said hello',
  asked: 'Asked about something',
  wanted: 'Wanted to buy',
  billed: 'Got a payment link',
  paid: 'Paid',
};
