import { describe, expect, it } from 'vitest';
import { summariseConversation } from '../src/modules/messages/conversations.js';

/**
 * One row per customer, and an honest answer to "does this need me?"
 *
 * The inbox used to be one flat list of every message, inbound and outbound
 * mixed. A shop's own replies appeared as if customers had sent them, tagged
 * with intent badges, and fifty customers texting at once would have been
 * unreadable.
 *
 * "Needs you" was worse than unreadable — it was wrong. It counted every
 * message ever flagged for review, and the only thing that ever cleared the
 * flag was re-labelling the message's intent. Answering the customer did not.
 * So the badge could only grow, and read 20 in a shop with nothing waiting.
 *
 * The definition here is the one an owner means: a flagged customer message
 * that nobody from the shop has answered SINCE. It is derived rather than
 * stored, so it is right whichever way the owner replied — from the dashboard,
 * from their own phone, or by the assistant — without anything having to
 * remember to clear a flag.
 */

const minutes = (n: number): Date => new Date(Date.UTC(2026, 8, 22, 12, n));

const CUSTOMER = {
  id: 'cus_1',
  name: 'Kwame Mensah',
  waNumber: '233558425882',
  lastInteractionAt: minutes(30),
};

function latest(direction: 'INBOUND' | 'OUTBOUND', at: Date, body = 'hello') {
  return { body, direction, createdAt: at, sentFromApp: false, sentByStaffId: null };
}

describe('summariseConversation', () => {
  it('needs you when a flagged message has had no reply', () => {
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('INBOUND', minutes(20)),
      lastOutboundAt: minutes(10),
      flaggedInboundAt: [minutes(20)],
    });

    expect(row.needsYou).toBe(true);
    expect(row.waiting).toBe(1);
  });

  it('stops needing you once the shop has answered', () => {
    // The badge that could only grow. A reply after the flagged message means
    // it has been dealt with, however that reply was sent.
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('OUTBOUND', minutes(25)),
      lastOutboundAt: minutes(25),
      flaggedInboundAt: [minutes(20)],
    });

    expect(row.needsYou).toBe(false);
    expect(row.waiting).toBe(0);
  });

  it('counts only the flagged messages that came after the last reply', () => {
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('INBOUND', minutes(28)),
      lastOutboundAt: minutes(15),
      flaggedInboundAt: [minutes(5), minutes(20), minutes(28)],
    });

    // The one at :05 was answered at :15; the two after it were not.
    expect(row.waiting).toBe(2);
  });

  it('counts every flagged message when the shop has never replied', () => {
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('INBOUND', minutes(20)),
      lastOutboundAt: null,
      flaggedInboundAt: [minutes(5), minutes(20)],
    });

    expect(row.waiting).toBe(2);
  });

  it('does not need you when nothing was flagged', () => {
    // An ordinary conversation the assistant handled on its own.
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('INBOUND', minutes(20)),
      lastOutboundAt: minutes(10),
      flaggedInboundAt: [],
    });

    expect(row.needsYou).toBe(false);
  });

  it('previews the most recent message and says who sent it', () => {
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('OUTBOUND', minutes(25), 'Yes, GHS 120.'),
      lastOutboundAt: minutes(25),
      flaggedInboundAt: [],
    });

    expect(row.preview).toEqual({ body: 'Yes, GHS 120.', fromShop: true, at: minutes(25) });
  });

  it('orders by the customer’s last activity', () => {
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: latest('INBOUND', minutes(20)),
      lastOutboundAt: null,
      flaggedInboundAt: [],
    });

    expect(row.lastActivityAt).toEqual(minutes(30));
  });

  it('survives a customer with no messages yet', () => {
    const row = summariseConversation({
      customer: CUSTOMER,
      latest: null,
      lastOutboundAt: null,
      flaggedInboundAt: [],
    });

    expect(row.preview).toBeNull();
    expect(row.needsYou).toBe(false);
  });
});
