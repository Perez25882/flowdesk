import crypto from 'node:crypto';
import type { IntentClassification } from '@flowdesk/shared';
import { IntentType } from '@flowdesk/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import type { AiClassifier } from './ai-classifier.js';

const MODEL_ID = 'claude-3-haiku-20240307';
const MAX_TOKENS = 64;
const TIMEOUT_MS = 3_000;
const MAX_INPUT_LENGTH = 500;
const CACHE_TTL_SECONDS = 86_400;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You classify WhatsApp messages sent to a Ghanaian business into one of:
ORDER, PAYMENT, INQUIRY, STATUS_CHECK, COMPLAINT, GREETING, OTHER.
Messages may be in English, Ghanaian English, or Pidgin.
Respond ONLY with JSON: {"intent":"ORDER","confidence":0.9}
No explanation. No markdown. No preamble.`;

const VALID_AI_INTENTS: readonly string[] = [
  IntentType.ORDER,
  IntentType.PAYMENT,
  IntentType.INQUIRY,
  IntentType.STATUS_CHECK,
  IntentType.COMPLAINT,
  IntentType.GREETING,
  IntentType.OTHER,
];

function computeCacheKey(text: string): string {
  const normalized = text.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `intent:${hash.slice(0, 16)}`;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

function truncateInput(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_INPUT_LENGTH)}...`;
}

function parseAiResponse(raw: string): IntentClassification | null {
  let trimmed = raw.trim();

  if (trimmed.startsWith('```')) {
    const lines = trimmed.split('\n');
    if (lines[0]?.startsWith('```')) {
      lines.shift();
    }
    if (lines[lines.length - 1]?.startsWith('```')) {
      lines.pop();
    }
    trimmed = lines.join('\n').trim();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    logger.warn({ raw }, 'Claude Haiku returned malformed JSON');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  const intentValue = record.intent;
  if (typeof intentValue !== 'string') {
    return null;
  }

  if (!VALID_AI_INTENTS.includes(intentValue)) {
    logger.warn({ intent: intentValue }, 'Claude Haiku returned invalid intent value');
    return null;
  }

  const confidenceValue = record.confidence;
  let confidence = 0;

  if (typeof confidenceValue === 'number') {
    confidence = Math.max(0, Math.min(1, confidenceValue));
  }

  return {
    intent: intentValue as IntentType,
    confidence: parseFloat(confidence.toFixed(2)),
    matchedPatterns: [],
  };
}

function createUnclassified(): IntentClassification {
  return {
    intent: IntentType.UNCLASSIFIED,
    confidence: 0,
    matchedPatterns: [],
  };
}

export class ClaudeHaikuClassifier implements AiClassifier {
  readonly name = 'ClaudeHaiku';

  async classify(text: string): Promise<IntentClassification> {
    const cacheKey = computeCacheKey(text);

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as IntentClassification;
        if (parsed && typeof parsed.intent === 'string' && typeof parsed.confidence === 'number') {
          logger.debug({ cacheKey }, 'Intent classification cache hit');
          return parsed;
        }
      }
    } catch {
      logger.warn({ cacheKey }, 'Failed to parse cached intent classification');
    }

    const truncated = truncateInput(text);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: truncated }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        logger.error(
          { status: response.status, body: errorBody },
          'Claude Haiku API returned non-OK status',
        );
        return createUnclassified();
      }

      const data = (await response.json()) as AnthropicResponse;
      const rawText = data.content?.[0]?.text;

      if (typeof rawText !== 'string') {
        logger.warn({ data }, 'Claude Haiku response missing text content');
        return createUnclassified();
      }

      const classification = parseAiResponse(rawText);

      if (classification === null) {
        return createUnclassified();
      }

      try {
        await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(classification));
      } catch {
        logger.warn({ cacheKey }, 'Failed to cache intent classification in Redis');
      }

      return classification;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('Claude Haiku classification timed out');
      } else {
        logger.error({ error }, 'Claude Haiku classification failed');
      }

      return createUnclassified();
    }
  }
}
