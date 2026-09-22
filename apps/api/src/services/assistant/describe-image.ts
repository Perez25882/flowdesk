import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getArchivedMedia } from '../s3/media.js';

/**
 * Reading a shop's own photo, once, so replies to it can be answered.
 *
 * Called at most once per image — `status-context.ts` caches the result on the
 * message row, because one Status post gets twenty replies and this is the
 * expensive step.
 *
 * Off unless `VISION_MODEL` is set. That is deliberate and it is the lesson the
 * provider next door paid for: a hosted model name written into a source file
 * as a default outlives the model, the endpoint starts returning 410, and
 * nothing fails loudly enough for anyone to notice for six days. So there is no
 * default here. Set it to a name you have checked against the live catalogue,
 * and until you have, the assistant degrades to asking a good question instead
 * of a wrong one — which it does perfectly well without this.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Longer than this and it is not a description, it is an essay about a flyer. */
const MAX_TOKENS = 220;

/** A reply is waiting on this. Better a good question late than no reply at all. */
const TIMEOUT_MS = 8_000;

/** 4MB. Above this it is not a Status photo and is not worth a customer's wait. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * What the model is asked for.
 *
 * Written for the one thing this description is used for: letting the assistant
 * work out which catalogue item a customer means. So it asks for the things
 * customers say — what the item is, its colour, any price or text printed on
 * the flyer — and explicitly not for the things a captioning model volunteers,
 * like the mood of the photograph or the quality of the lighting.
 */
const PROMPT = [
  'This picture was posted by a small shop to their WhatsApp Status. Customers are',
  'replying to it and the shop needs to know what they are pointing at.',
  '',
  'Describe what is FOR SALE in it, in two or three short sentences.',
  '',
  '- Name each item plainly: "three kaftans, one navy, one white, one striped".',
  '- Copy any price, discount or text printed on the image exactly as written.',
  '- If it is a flyer with several items, list them.',
  '- Do not describe the lighting, the background, the mood, or the person modelling.',
  '- Do not guess a price that is not printed on it.',
  '- If nothing is clearly for sale, say what the picture is in one sentence.',
].join('\n');

export interface DescribeInput {
  mediaKey: string;
}

/**
 * Describes a stored image, or returns null.
 *
 * Null on every failure path — no key configured, no model configured, a slow
 * provider, an unreadable object, a refusal. Every caller already has a
 * sensible thing to do without a description, and none of them should be made
 * to care why one is missing.
 */
export async function describeImageForReply(input: DescribeInput): Promise<string | null> {
  const model = env.VISION_MODEL;
  const apiKey = env.GROQ_API_KEY;

  if (!model || !apiKey) return null;

  let dataUrl: string;

  try {
    const media = await getArchivedMedia(input.mediaKey);
    if (!media) return null;

    const chunks: Buffer[] = [];
    for await (const chunk of media.body) {
      chunks.push(Buffer.from(chunk as Buffer));
      // A shop photo is under a megabyte. Anything materially larger is not a
      // Status picture, and buffering it whole inside the reply path would
      // trade a customer's wait for a description nobody asked for.
      if (chunks.reduce((sum, part) => sum + part.length, 0) > MAX_IMAGE_BYTES) {
        logger.warn({ mediaKey: input.mediaKey }, 'Image too large to describe');
        return null;
      }
    }

    // Sent inline rather than as a URL. The bucket is private, and minting a
    // signed URL for a third party to fetch would put the shop's own photos on
    // a public address for as long as the signature lives.
    dataUrl = `data:${media.contentType};base64,${Buffer.concat(chunks).toString('base64')}`;
  } catch (error: unknown) {
    logger.warn({ error, mediaKey: input.mediaKey }, 'Could not read image for description');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      // Logged at warn with the status, because a 410 here is the exact failure
      // mode that went unnoticed for six days on the text provider: the feature
      // silently stops working and everything else carries on.
      logger.warn(
        { status: response.status, model },
        'Vision model rejected a description request',
      );
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return payload.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (error: unknown) {
    logger.warn({ error, model }, 'Vision request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
