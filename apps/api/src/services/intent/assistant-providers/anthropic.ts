import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import type {
  AssistantProvider,
  GenerateInput,
  ProviderFailure,
  ProviderResult,
} from './types.js';

/**
 * Anthropic, via structured outputs.
 *
 * Kept alongside the NVIDIA provider so `AI_PROVIDER` switches the assistant the
 * same way it already switches the classifier. Nothing downstream knows which
 * one answered.
 */

const DEFAULT_MODEL = 'claude-opus-5';

let cachedClient: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({
      apiKey,
      // Retrying inside the request multiplies latency against a worker with
      // limited concurrency. BullMQ retries the job; the breaker stops pile-ups.
      maxRetries: 0,
      timeout: env.ASSISTANT_TIMEOUT_MS,
    });
  }
  return cachedClient;
}

function classifyError(error: unknown): ProviderFailure {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (error instanceof Anthropic.APIConnectionError) return 'api_error';
  if (error instanceof Anthropic.APIError) return 'api_error';
  return 'api_error';
}

export class AnthropicAssistantProvider implements AssistantProvider {
  readonly name = 'anthropic';

  private readonly model: string;

  constructor() {
    this.model = env.ASSISTANT_MODEL ?? DEFAULT_MODEL;
  }

  async generate(input: GenerateInput): Promise<ProviderResult> {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, reason: 'not_configured' };

    try {
      const response = await getClient(apiKey).beta.messages.create({
        model: this.model,
        max_tokens: env.ASSISTANT_MAX_TOKENS,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: input.userPrompt }],
        output_config: {
          effort: env.ASSISTANT_EFFORT,
          format: { type: 'json_schema', schema: input.schema },
        },
        // A safety refusal here would silently drop a customer's message;
        // routing to the recommended fallback model recovers the reply.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });

      // Checked before reading content: a refusal is an HTTP 200 with an empty
      // or partial body, so indexing into `content` first looks like success.
      if (response.stop_reason === 'refusal') {
        logger.warn(
          { category: response.stop_details?.category },
          'Assistant request was refused',
        );
        return { ok: false, reason: 'refused' };
      }

      if (response.stop_reason === 'max_tokens') {
        logger.warn(
          { maxTokens: env.ASSISTANT_MAX_TOKENS },
          'Assistant response hit max_tokens — raise ASSISTANT_MAX_TOKENS',
        );
        return { ok: false, reason: 'truncated' };
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        return { ok: false, reason: 'api_error' };
      }

      return {
        ok: true,
        generation: {
          text: textBlock.text,
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error: unknown) {
      const reason = classifyError(error);

      if (reason === 'timeout') {
        logger.warn({ timeoutMs: env.ASSISTANT_TIMEOUT_MS }, 'Assistant request timed out');
      } else {
        logger.error({ error, reason }, 'Assistant request failed');
      }

      return { ok: false, reason };
    }
  }
}

/** Test seam — the provider caches an SDK instance. */
export function resetAnthropicClientForTests(): void {
  cachedClient = null;
}
