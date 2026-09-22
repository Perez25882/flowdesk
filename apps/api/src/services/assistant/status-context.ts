import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';

/**
 * Understanding what a customer is replying to.
 *
 * This exists for one situation, and it is the situation a great many Ghanaian
 * shops actually sell in: the owner posts a photo or a flyer to their WhatsApp
 * Status, and people reply under it. "How much?" "Is the red one still there?"
 * "I want two." Every one of those arrives with no product named, because the
 * product is in a picture the customer is looking at and the assistant is not.
 *
 * Before this, the reply was answered with "which item do you mean?" — to
 * somebody staring straight at the answer. It is the single most embarrassing
 * thing the assistant did, and no amount of prompt work fixes it, because the
 * information genuinely was not there.
 *
 * Four sources, cheapest and most reliable first:
 *
 *   1. The caption. If the shop wrote one, it is better than anything we could
 *      infer, and it is free.
 *   2. A description already stored for that image. Written once and reused,
 *      because one Status gets twenty replies and reading the picture twenty
 *      times would be twenty times the cost for the same answer.
 *   3. A description read off the picture now, and cached.
 *   4. Nothing — and saying so plainly, which is still far better than silence.
 *      An assistant told "they are replying to a picture you cannot see" asks a
 *      useful question. One told nothing asks a useless one.
 */

export type DescriptionSource = 'CAPTION' | 'VISION' | 'OWNER';

export interface RepliedToContext {
  /** What the message said, or what the picture shows. */
  body: string | null;
  fromShop: boolean;
  /** True when the thing replied to was a picture rather than text. */
  isImage: boolean;
  /**
   * True when we know they replied to something of the shop's but hold nothing
   * about it at all.
   *
   * Distinct from "no reply context" — it is the difference between a customer
   * writing out of the blue and one pointing at something. The first should be
   * asked what they need; the second should be asked WHICH, and never asked to
   * repeat themselves.
   */
  unresolved: boolean;
}

const MAX_DESCRIPTION_LENGTH = 400;

/**
 * Everything known about the message this one replies to.
 *
 * Returns `unresolved` rather than null when the referenced message is missing:
 * a Status posted before this shop was onboarded, or one Meta never mirrored to
 * us. We do not know what it showed, but we do know the customer is pointing at
 * something, and that fact changes the right reply.
 */
export async function resolveRepliedTo(
  businessId: string,
  replyToWaId: string,
  describeImage?: ImageDescriber,
): Promise<RepliedToContext | null> {
  const target = await prisma.message.findFirst({
    where: { businessId, waMessageId: replyToWaId },
    select: {
      id: true,
      body: true,
      direction: true,
      type: true,
      mediaKey: true,
      mediaType: true,
      mediaDescription: true,
    },
  });

  if (!target) {
    return { body: null, fromShop: true, isImage: false, unresolved: true };
  }

  const fromShop = target.direction === 'OUTBOUND';
  const isImage = target.type === 'IMAGE';
  const caption = target.body?.trim();

  // A caption beats everything. The shop wrote it about its own picture.
  if (caption) {
    return {
      body: caption.slice(0, MAX_DESCRIPTION_LENGTH),
      fromShop,
      isImage,
      unresolved: false,
    };
  }

  if (!isImage) {
    // Text with no text. Nothing to attach, and nothing to be clever about.
    return { body: null, fromShop, isImage: false, unresolved: false };
  }

  if (target.mediaDescription) {
    return {
      body: target.mediaDescription.slice(0, MAX_DESCRIPTION_LENGTH),
      fromShop,
      isImage: true,
      unresolved: false,
    };
  }

  // Nothing stored yet. Read it once, keep it, and never read it again.
  if (describeImage && target.mediaKey) {
    const described = await describeAndStore(target.id, target.mediaKey, describeImage);
    if (described) {
      return { body: described, fromShop, isImage: true, unresolved: false };
    }
  }

  // A picture we hold and cannot describe. The assistant is told that much,
  // which is enough for it to ask a good question instead of a blank one.
  return { body: null, fromShop, isImage: true, unresolved: false };
}

export interface ImageDescriber {
  (input: { mediaKey: string }): Promise<string | null>;
}

/**
 * Describes an image and writes the result to the message row.
 *
 * Failure is swallowed deliberately. This runs inside the reply path, and a
 * vision provider being slow or down must degrade the answer, never stop the
 * customer getting one — the fallback below it is already a usable reply.
 */
async function describeAndStore(
  messageId: string,
  mediaKey: string,
  describeImage: ImageDescriber,
): Promise<string | null> {
  try {
    const description = (await describeImage({ mediaKey }))?.trim();
    if (!description) return null;

    const stored = description.slice(0, MAX_DESCRIPTION_LENGTH);

    // Conditional on still being empty: two replies to the same Status can
    // arrive together, and the loser of that race must not overwrite a
    // description the winner already wrote and may already have used.
    await prisma.message.updateMany({
      where: { id: messageId, mediaDescription: null },
      data: { mediaDescription: stored, mediaDescribedBy: 'VISION' satisfies DescriptionSource },
    });

    return stored;
  } catch (error: unknown) {
    logger.warn({ error, messageId }, 'Could not describe replied-to image');
    return null;
  }
}

/**
 * How the reply context is written into the prompt.
 *
 * Separate from the resolution above so the wording can be argued with in a
 * test rather than buried in a query. Each branch says something different and
 * asks for something different, which is the entire point — a blanket "they
 * replied to something" would produce the same useless question in all four
 * cases.
 */
export function renderRepliedTo(context: RepliedToContext): string {
  if (context.unresolved) {
    return [
      'The customer is replying to something this shop posted — almost certainly a photo or',
      'a flyer on WhatsApp Status. You cannot see it and neither can the system.',
      '',
      'Do NOT ask them what they are referring to. They are looking at it; from where they',
      'sit the question is nonsense and it makes the shop look like it is not paying',
      'attention. Instead, answer what you can and ask them to name the item, offering the',
      'most likely ones from the catalogue by name: "Is that the blue kaftan or the white',
      'one?" is a good question. "What are you referring to?" is not.',
    ].join('\n');
  }

  if (context.isImage && !context.body) {
    return [
      'The customer is replying to a picture this shop posted. We have the picture but not',
      'a description of it, so you do not know what is in it.',
      '',
      'Do not pretend to know, and do not ask them what they mean — they can see it. Name',
      'the likeliest items from the catalogue and ask them which one, or answer anything in',
      'their message that stands on its own.',
    ].join('\n');
  }

  if (!context.body) {
    return 'The customer is replying to an earlier message, but there is nothing in it to go on.';
  }

  if (context.isImage) {
    return [
      context.fromShop
        ? 'The customer is replying to a picture this shop posted. This is what it shows:'
        : 'The customer is replying to a picture they sent. This is what it shows:',
      `"${context.body}"`,
      '',
      'When they say "it", "this", "that" or "the one in the picture", they mean what is',
      'described above. Answer about that. Do not ask them which item they mean.',
    ].join('\n');
  }

  return context.fromShop
    ? `The shop posted this, and the customer replied to it. When they say "it", "this" or "that", they mean whatever is described here. Answer about that, do not ask them what they mean:\n"${context.body}"`
    : `The customer is replying to their own earlier message:\n"${context.body}"`;
}
