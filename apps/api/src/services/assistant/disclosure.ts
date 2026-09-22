import type { AiAssistMode } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';

/**
 * Telling the customer they are talking to software.
 *
 * Added because of a gap nothing in the terms can close. Flowdesk's terms bind
 * the shop; the shop's customer has never read them and is not party to them.
 * When an autonomous assistant states a delivery charge nobody set, the person
 * who acts on it has no agreement with anyone and no way of knowing a machine
 * wrote it.
 *
 * One line, once per conversation, only in AUTONOMOUS mode. Three reasons it is
 * worth the characters:
 *
 * A customer who knows they are talking to an assistant reads a wrong price as
 * a system error rather than as the shop lying to them — which is the
 * difference between a correction and a lost customer.
 *
 * It is what Meta's own policies point at for automated agents on the WhatsApp
 * Business Platform, and what transparency under the Data Protection Act asks
 * of automated processing.
 *
 * And it is the only protection that reaches the person actually exposed. The
 * shop accepted this risk knowingly; their customer did not.
 *
 * Not shown in GROUNDED_AUTO. There, every figure sent unsupervised was checked
 * against the shop's own records first, so the claim behind it is the shop's
 * claim — the same one they would have made themselves.
 */
const DISCLOSURE = "— Replies here are automated and can be wrong; we'll confirm anything important.";

/**
 * How long before a customer is told again.
 *
 * Long enough that a regular is not reminded on every purchase, short enough
 * that somebody returning after a month is not left to assume a person has been
 * answering them all along.
 */
const REPEAT_AFTER_DAYS = 30;

/**
 * The line to append, or null.
 *
 * Errs towards saying nothing on failure rather than towards repeating itself:
 * a missing disclosure is a gap, but one appended to every single message is a
 * shop that looks like it does not trust its own replies, and the owner turns
 * the assistant off.
 */
export async function autonomyDisclosureFor(
  mode: AiAssistMode,
  businessId: string,
  customerId: string,
): Promise<string | null> {
  if (mode !== 'AUTONOMOUS') return null;

  try {
    const since = new Date(Date.now() - REPEAT_AFTER_DAYS * 24 * 60 * 60 * 1000);

    // Matched on the sentence itself rather than on a flag column. It means the
    // check is exact — it finds what was actually sent — and it survives the
    // wording being changed, because a new sentence correctly counts as not yet
    // having been said.
    const told = await prisma.message.findFirst({
      where: {
        businessId,
        customerId,
        direction: 'OUTBOUND',
        createdAt: { gte: since },
        body: { contains: DISCLOSURE },
      },
      select: { id: true },
    });

    return told ? null : DISCLOSURE;
  } catch (error: unknown) {
    logger.error({ error, businessId, customerId }, 'Could not check the automation disclosure');
    return null;
  }
}

export { DISCLOSURE as AUTOMATION_DISCLOSURE, REPEAT_AFTER_DAYS };
