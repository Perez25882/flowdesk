import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTRACT_VERSION, IntentType, type AssistantDecision } from '@flowdesk/shared';
import { requiresReview, routeDecision, type RouteInput } from '../src/services/assistant/router.js';
import { buildEvidenceSet, type EvidenceProduct } from '../src/services/assistant/evidence.js';

const products: EvidenceProduct[] = [
  { id: 'p_rice5', name: 'Rice 5kg', unit: 'bag', price: 80, stockQuantity: 12 },
  { id: 'p_rice25', name: 'Rice 25kg', unit: 'bag', price: 350, stockQuantity: 4 },
  { id: 'p_malta', name: 'Malta Guinness 33cl', unit: 'bottle', price: 12.5, stockQuantity: 0 },
];

const evidence = buildEvidenceSet({
  products,
  profile: { deliveryFee: 20, deliveryAreas: ['Tema', 'Spintex'] },
  openOrders: [],
  mentionedQuantities: [2],
  businessPhones: ['0244000111'],
});

function decisionFor(overrides: Partial<AssistantDecision> = {}): AssistantDecision {
  return {
    version: ASSISTANT_CONTRACT_VERSION,
    intent: IntentType.INQUIRY,
    confidence: 0.95,
    language: 'gh_en',
    sentiment: 'neutral',
    entities: { products: [], orderReferences: [], deliveryArea: null },
    answer: {
      canAnswer: true,
      text: null,
      fact: { kind: 'product_quote', target: 'p_rice5', quantity: null },
      groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
    },
    clarification: { needed: false, missing: [] },
    order: { isOrder: false, complete: false },
    escalate: { needed: false, reason: null },
    priceOffer: null,
    ...overrides,
  };
}

function routeFor(overrides: Partial<RouteInput> = {}) {
  return routeDecision({
    mode: 'GROUNDED_AUTO',
    decision: decisionFor(),
    evidence,
    products,
    profile: { deliveryFee: 20, deliveryAreas: ['Tema', 'Spintex'] },
    serverEscalation: false,
    clarificationCount: 0,
    canDeliver: true,
    catalogueMode: 'CATALOGUE',
    message: 'How much is Rice 5kg?',
    ...overrides,
  });
}

describe('routeDecision — the auto-send slice', () => {
  it('sends a grounded, confident, single-product price answer', () => {
    const result = routeFor();
    expect(result.action).toBe('auto_send');
    expect(result.text).toContain('GHS 80.00');
    expect(result.validationFailures).toEqual([]);
  });

  it('sends an answer resting only on a business fact', () => {
    const result = routeFor({
      message: 'Do you deliver to Tema and how much?',
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Delivery to Tema is GHS 20.',
          fact: { kind: 'delivery_fee', target: 'Tema', quantity: null },
          groundedOn: [{ kind: 'business_fact', id: 'deliveryFee' }],
        },
      }),
    });

    expect(result.action).toBe('auto_send');
  });

  it('records what the answer rested on in a form the message row can store', () => {
    expect(routeFor().groundedOn).toEqual(['product:p_rice5']);
  });
});

describe('routeDecision — everything that blocks auto-send', () => {
  it('drafts when the tenant has not switched auto-send on', () => {
    expect(routeFor({ mode: 'DRAFT_ONLY' }).action).toBe('draft');
  });

  it('writes nothing at all when the assistant is off', () => {
    const result = routeFor({ mode: 'OFF' });
    expect(result.action).toBe('template_reply');
    expect(result.text).toBeNull();
  });

  it('drafts a price the evidence set does not carry', () => {
    // The number is plausible, the product is real, and it is still wrong.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 75 per bag.',
          groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
        },
      }),
    });

    expect(result.action).toBe('draft');
    expect(result.validationFailures).toContain('unverified_amount');
  });

  it('drafts an answer that affirms availability of something out of stock', () => {
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Yes we have Malta Guinness, GHS 12.50 a bottle.',
          groundedOn: [{ kind: 'product', id: 'p_malta', field: 'price' }],
        },
      }),
    });

    expect(result.action).toBe('draft');
    expect(result.validationFailures).toContain('availability_contradicts_stock');
  });

  it('drafts anything carrying a link or a foreign number', () => {
    const withLink = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 80. Pay at https://pay.example.com',
          groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
        },
      }),
    });

    expect(withLink.action).toBe('draft');
    expect(withLink.validationFailures).toContain('contains_url');

    const withPhone = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice 5kg is GHS 80. Send money to 0201234567.',
          groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
        },
      }),
    });

    expect(withPhone.validationFailures).toContain('foreign_phone_number');
  });

  it('drafts an answer that cites more than one product', () => {
    // "Rice is GHS 80" is wrong at a shop selling two sizes of rice, even
    // though 80 is a real price.
    const result = routeFor({
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Rice is GHS 80.',
          groundedOn: [
            { kind: 'product', id: 'p_rice5', field: 'price' },
            { kind: 'product', id: 'p_rice25', field: 'price' },
          ],
        },
      }),
    });

    expect(result.action).toBe('draft');
  });

  it('drafts a low-confidence answer even when every figure checks out', () => {
    expect(routeFor({ decision: decisionFor({ confidence: 0.5 }) }).action).toBe('draft');
  });

  it('never auto-sends an order, even a fully settled one', () => {
    // A commitment is not a question. It goes through order creation where the
    // owner can see it, never out as a chat reply nobody reviewed.
    const result = routeFor({
      decision: decisionFor({
        order: { isOrder: true, complete: true },
        answer: { canAnswer: false, text: null, groundedOn: [] },
        entities: {
          products: [{ productId: 'p_rice5', mention: 'Rice 5kg', quantity: 2 }],
          orderReferences: [],
          deliveryArea: null,
        },
      }),
    });

    expect(result.action).toBe('draft');
  });

  it('asks rather than drafts when an order names no product it can price', () => {
    // The server derives this: the model reported nothing missing, but with two
    // sizes retrieved and none chosen there is no order to create.
    expect(
      routeFor({ message: 'I want Rice', decision: decisionFor({ order: { isOrder: true, complete: true }, answer: { canAnswer: false, text: null, groundedOn: [] } }) }).action,
    ).toBe('clarify');
  });

  /**
   * The intent allow-list is gone, deliberately, on the owner's instruction.
   *
   * It used to draft anything that was not an INQUIRY or a STATUS_CHECK. That
   * read well as a policy and behaved badly as a product: "alright, thanks" and
   * "no, we don't sell corporate attire" are neither of those intents, state no
   * fact, and were still queued for a human to approve. The shop looked slow and
   * evasive about things it already knew.
   *
   * What a reply CLAIMS now decides, not what the message was about. The money
   * cases are still covered, by better gates than an intent name:
   *
   *   - anything the model escalates (bargaining, complaints, policy) drafts
   *   - anything order-shaped goes through order creation, never a chat reply
   *   - any figure not in the catalogue fails grounding and drafts
   */
  it('uses a bounded reply for an ordinary acknowledgment', () => {
    const result = routeFor({ message: 'Thank you', decision: decisionFor({ answer: { canAnswer: false, text: 'Thank you', groundedOn: [] } }) });
    expect(result).toMatchObject({ action: 'auto_send', text: 'You’re welcome!' });
  });

  it('still drafts a payment or complaint the model escalated', () => {
    for (const intent of [IntentType.PAYMENT, IntentType.COMPLAINT]) {
      expect(
        routeFor({
          decision: decisionFor({ intent, escalate: { needed: true, reason: 'complaint' } }),
        }).action,
        intent,
      ).toBe('draft');
    }
  });

  it('drafts when the model asked for a person', () => {
    expect(
      routeFor({
        decision: decisionFor({ escalate: { needed: true, reason: 'bargaining' } }),
      }).action,
    ).toBe('draft');
  });

  it('drafts when the server escalated, whatever the model said', () => {
    const result = routeFor({ serverEscalation: true });
    expect(result.action).toBe('draft');
    expect(result.escalated).toBe(true);
  });

  it('drafts rather than sending once the 24-hour window has closed', () => {
    // Meta would reject it, the job would dead-letter, and the owner would never
    // learn the customer went unanswered.
    expect(routeFor({ canDeliver: false }).action).toBe('draft');
  });
});

describe('routeDecision — clarification', () => {
  const needsQuantity = decisionFor({
    intent: IntentType.ORDER,
    answer: { canAnswer: false, text: null, groundedOn: [] },
    clarification: { needed: true, missing: ['quantity'] },
    order: { isOrder: true, complete: false },
  });

  it('asks a question composed from real catalogue rows', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products: [products[0]!],
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
      message: 'I want Rice 5kg',
    });

    expect(result.action).toBe('clarify');
    expect(result.text).toBe('How many units of “Rice 5kg” would you like?');
  });

  it('asks even when auto-send is off — the question is ours, not the model’s', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
      message: 'I want Rice',
    });

    expect(result.action).toBe('clarify');
  });

  it('asks for the item and quantity when the variant is unverified', () => {
    // The model reported only `quantity` missing, against a variant nobody
    // chose — live it produced "how many Rice 25kg?" for a bare "I want rice".
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: decisionFor({
        intent: IntentType.ORDER,
        answer: { canAnswer: false, text: null, groundedOn: [] },
        entities: {
          products: [{ productId: 'p_rice25', mention: 'rice', quantity: null }],
          orderReferences: [],
          deliveryArea: null,
        },
        clarification: { needed: true, missing: ['quantity'] },
        order: { isOrder: true, complete: false },
      }),
      evidence,
      products: [products[0]!, products[1]!],
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
      message: 'I want Rice',
    });

    expect(result.action).toBe('clarify');
    expect(result.text).toContain('Which item and quantity would you like?');
    expect(result.text).not.toContain('How many');
  });

  it('asks how many once only one product is in play', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: decisionFor({
        intent: IntentType.ORDER,
        answer: { canAnswer: false, text: null, groundedOn: [] },
        entities: {
          products: [{ productId: 'p_rice5', mention: 'rice 5kg', quantity: null }],
          orderReferences: [],
          deliveryArea: null,
        },
        clarification: { needed: true, missing: ['quantity'] },
        order: { isOrder: true, complete: false },
      }),
      evidence,
      products: [products[0]!],
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
      message: 'I want Rice 5kg',
    });

    expect(result.text).toBe('How many units of “Rice 5kg” would you like?');
  });

  it('stops asking after the cap and hands over', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: false,
      clarificationCount: 2,
      canDeliver: true,
    });

    expect(result.action).not.toBe('clarify');
  });

  it('does not ask a question it cannot send', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: false,
    });

    expect(result.action).not.toBe('clarify');
  });

  it('escalates instead of asking when a person is needed', () => {
    const result = routeDecision({
      mode: 'DRAFT_ONLY',
      decision: needsQuantity,
      evidence,
      products,
      profile: null,
      serverEscalation: true,
      clarificationCount: 0,
      canDeliver: true,
    });

    expect(result.action).not.toBe('clarify');
    expect(result.escalated).toBe(true);
  });
});

describe('routeDecision — when the assistant did not run', () => {
  it('holds for review when the model is unavailable', () => {
    const result = routeFor({ decision: null });
    expect(result).toMatchObject({ action: 'draft', effect: 'handoff' });
  });

  it('flags a provider failure and preserves the OFF courtesy policy', () => {
    expect(routeFor({ decision: null }).escalated).toBe(true);
    expect(requiresReview(IntentType.GREETING, 0.8, 'template_reply', false)).toBe(false);
  });

  it('still routes the messages a person always had to answer', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.9, 'template_reply', false)).toBe(true);
  });
});

describe('requiresReview', () => {
  it('leaves an auto-sent answer out of the queue', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.95, 'auto_send', false)).toBe(false);
  });

  it('leaves a clarification out of the queue — it is being handled', () => {
    expect(requiresReview(IntentType.ORDER, 0.9, 'clarify', false)).toBe(false);
  });

  it('queues a draft, which is waiting on the owner by definition', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.95, 'draft', false)).toBe(true);
  });

  it('queues anything escalated regardless of how it was handled', () => {
    expect(requiresReview(IntentType.INQUIRY, 0.95, 'auto_send', true)).toBe(true);
  });

  it('keeps the old intent rule when the assistant did not run', () => {
    // Without a reply written, these are exactly the messages an owner has
    // always had to answer themselves.
    expect(requiresReview(IntentType.INQUIRY, 0.9, 'template_reply', false)).toBe(true);
    expect(requiresReview(IntentType.COMPLAINT, 0.9, 'template_reply', false)).toBe(true);
    expect(requiresReview(IntentType.PAYMENT, 0.9, 'template_reply', false)).toBe(true);
    expect(requiresReview(IntentType.GREETING, 0.9, 'template_reply', false)).toBe(false);
  });

  it('queues an unclassified or low-confidence message however it was routed', () => {
    expect(requiresReview(IntentType.UNCLASSIFIED, 0.9, 'auto_send', false)).toBe(true);
    expect(requiresReview(IntentType.INQUIRY, 0.4, 'auto_send', false)).toBe(true);
  });
});

/**
 * Which photo, if any, rides along with an answer.
 *
 * The decision is the server's, not the model's, so it is tested here rather
 * than inferred from a prompt. Two failures are worth more than the happy path:
 * sending a picture nobody asked for, and sending one picture as the answer to
 * a question that covered two products.
 */
describe('routeDecision — attaching a product photo', () => {
  const withPhotos: EvidenceProduct[] = [
    { ...products[0]!, photoId: 'img_rice5' },
    { ...products[1]!, photoId: 'img_rice25' },
    { ...products[2]!, photoId: null },
  ];

  it('attaches the photo when the customer asked to see the item', () => {
    const result = routeFor({
      products: withPhotos,
      message: 'do you have rice 5kg? send picture',
    });
    expect(result.action).toBe('auto_send');
    expect(result.photoImageId).toBe('img_rice5');
  });

  it('understands the Pidgin forms, not only "send a picture"', () => {
    for (const message of ['rice 5kg make i see', 'how rice 5kg e dey look? show me', 'show me the rice 5kg']) {
      expect(routeFor({ products: withPhotos, message }).photoImageId).toBe('img_rice5');
    }
  });

  it('sends nothing when the customer only asked the price', () => {
    const result = routeFor({ products: withPhotos, message: 'how much be rice 5kg' });
    expect(result.action).toBe('auto_send');
    expect(result.photoImageId).toBeNull();
  });

  it('sends nothing when the shop has no photo for that product', () => {
    const result = routeFor({
      products: withPhotos,
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Malta is GHS 12.50 per bottle, but we are out of stock right now.',
          groundedOn: [{ kind: 'product', id: 'p_malta', field: 'price' }],
        },
      }),
      message: 'send me a picture of the malta',
    });
    expect(result.photoImageId).toBeNull();
  });

  it('sends nothing when the answer rests on a business fact rather than a product', () => {
    const result = routeFor({
      products: withPhotos,
      decision: decisionFor({
        answer: {
          canAnswer: true,
          text: 'Delivery to Tema is GHS 20.',
          groundedOn: [{ kind: 'business_fact', id: 'deliveryFee' }],
        },
      }),
      message: 'send picture of the delivery van',
    });
    expect(result.photoImageId).toBeNull();
  });

  it('never attaches a photo to a draft, which the owner has not approved yet', () => {
    const result = routeFor({
      products: withPhotos,
      // Low confidence forces the draft path while everything else stays valid.
      decision: decisionFor({ confidence: 0.4 }),
      message: 'send me a picture of the rice 5kg',
    });
    expect(result.action).toBe('draft');
    expect(result.photoImageId).toBeNull();
  });
});

/**
 * AUTONOMOUS mode.
 *
 * Autonomous turns share the evidence and permission gate.
 */
describe('routeDecision — autonomous mode', () => {
  const ungrounded = decisionFor({
    answer: {
      canAnswer: true,
      // GHS 45 is in no catalogue row and no business fact. Below AUTONOMOUS
      // this is exactly what `unverified_amount` holds back.
      text: 'Delivery to Kumasi is GHS 45.',
      groundedOn: [],
    },
  });

  it('holds a figure it cannot verify', () => {
    const result = routeFor({ mode: 'AUTONOMOUS', decision: ungrounded });
    expect(result.action).toBe('draft');
    expect(result.text).toBeNull();
  });

  it('holds that same reply in every other mode', () => {
    expect(routeFor({ mode: 'GROUNDED_AUTO', decision: ungrounded }).action).toBe('draft');
    expect(routeFor({ mode: 'DRAFT_ONLY', decision: ungrounded }).action).toBe('draft');
  });

  it('still records what it could not verify', () => {
    const result = routeFor({ mode: 'AUTONOMOUS', decision: ungrounded });
    expect(result.action).toBe('draft');
    expect(result.validationFailures.length).toBeGreaterThan(0);
    expect(result.validationFailures).toContain('unverified_amount');
  });

  it('holds a material quote below the confidence floor', () => {
    const result = routeFor({ mode: 'AUTONOMOUS', decision: decisionFor({ confidence: 0.3 }) });
    expect(result.action).toBe('draft');
  });

  it('still refuses to settle anything the model escalated', () => {
    // Bargaining, complaints and policy are the owner's authority, not an
    // accuracy check. Turning off accuracy checks did not give those away.
    const result = routeFor({
      mode: 'AUTONOMOUS',
      decision: decisionFor({
        escalate: { needed: true, reason: 'bargaining' },
      }),
    });
    expect(result.action).not.toBe('auto_send');
    expect(result.escalated).toBe(true);
  });

  it('still refuses when the server escalated on its own', () => {
    const result = routeFor({ mode: 'AUTONOMOUS', serverEscalation: true });
    expect(result.action).not.toBe('auto_send');
  });

  it('still sends nothing outside the 24-hour window', () => {
    // Meta's rule, not ours. No amount of autonomy makes a free-form message
    // deliverable there.
    const result = routeFor({ mode: 'AUTONOMOUS', canDeliver: false });
    expect(result.action).not.toBe('auto_send');
  });

  it('routes an explicit order to the business service in both automatic modes', () => {
    const order = decisionFor({
      order: { isOrder: true, complete: true },
      // The server resolves the items itself, so the mention has to name a real
      // product — otherwise both modes ask a clarifying question instead, which
      // is correct and not what this test is about.
      entities: {
        products: [{ productId: 'p_rice5', mention: 'rice 5kg', quantity: 2 }],
        orderReferences: [],
        deliveryArea: null,
      },
      answer: {
        canAnswer: true,
        text: 'Got it — 2 bags of Rice 5kg, GHS 160.',
        groundedOn: [{ kind: 'product', id: 'p_rice5', field: 'price' }],
      },
    });

    const message = 'I want 2 bags of Rice 5kg';
    expect(routeFor({ mode: 'AUTONOMOUS', decision: order, message }).effect).toBe('order');
    expect(routeFor({ mode: 'GROUNDED_AUTO', decision: order, message }).effect).toBe('order');
    expect(routeFor({ mode: 'DRAFT_ONLY', decision: order, message }).action).toBe('draft');
  });

  it('still sends nothing at all when the assistant is off', () => {
    expect(routeFor({ mode: 'OFF', decision: ungrounded }).action).toBe('template_reply');
  });
});
