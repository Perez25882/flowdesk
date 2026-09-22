import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { schemaInstruction } from './schema-instruction.js';
import type {
  AssistantProvider,
  GenerateInput,
  ProviderFailure,
  ProviderResult,
} from './types.js';

/**
 * Groq, via its OpenAI-compatible chat-completions endpoint.
 *
 * Added because latency is a product feature here, not an engineering vanity. A
 * shop owner watching a rep demo in a market stall reads a four-second pause as
 * "it is not working"; the customer on the other end reads it as being ignored.
 * Groq answers in a fraction of the time the shared open-model tiers manage,
 * which buys back the room to run a model large enough to be worth talking to —
 * and "the replies feel scripted" was, on inspection, mostly a small model.
 *
 * Everything downstream still assumes the model is fallible: the reply is
 * Zod-parsed, its citations are checked against rows the server supplied, and
 * every figure is verified before it may be sent. A better model produces fewer
 * drafts, not more permission.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Overridable with ASSISTANT_MODEL, and it will need overriding.
 *
 * The lesson from the NVIDIA provider next door is worth inheriting rather than
 * relearning: `meta/llama-3.1-8b-instruct` was retired mid-flight, every request
 * returned 410 Gone, and the assistant quietly served canned templates for six
 * days because nothing failed loudly enough for anyone to notice. Hosted
 * catalogues turn over faster than the comments describing them.
 *
 * So verify this name against Groq's live model list before trusting it, and
 * when it disappears set ASSISTANT_MODEL rather than editing this line in a
 * hurry. `qa/nv-models.mjs` is the shape of script to copy for that check.
 *
 * That warning earned itself immediately: `llama-3.3-70b-versatile` was the
 * obvious first choice and is not served on this account at all. Measured
 * 2026-09-02 against the live catalogue using this exact request shape —
 * qwen3.8-27b returned 4/4 valid JSON at 350–600ms, gpt-oss-120b 4/4 at
 * 0.9–1.4s. Both classified "What do you have??" as an inquiry, which the
 * previous 8B model got wrong. Qwen wins on latency and on voice: its Pidgin
 * reads like a shop rather than a form.
 */
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

/**
 * How long schema-constrained decoding stays off after a rejection.
 *
 * It used to stay off for the life of the process. That is right only if the
 * rejection means "this model cannot do it", and wrong in every other case —
 * and the other cases exist: a gateway hiccup, a model swapped behind the same
 * name, a transient 400 whose body happens to quote the request. The cost of
 * being wrong was invisible and expensive: constrained decoding is what makes
 * the decision schema binding, so the process quietly degraded to prompt-only
 * JSON and stayed there until someone restarted it.
 *
 * A bounded back-off keeps the cheap part of the original design — one 400 is
 * the whole cost of finding out — while making the answer expire.
 */
const SCHEMA_RETRY_AFTER_MS = 10 * 60 * 1000;

/** Epoch millis until which `json_schema` is not attempted. 0 means enabled. */
let schemaDisabledUntil = 0;

function structuredOutputAvailable(): boolean {
  if (schemaDisabledUntil === 0) return true;
  if (Date.now() < schemaDisabledUntil) return false;

  schemaDisabledUntil = 0;
  logger.info('Groq json_schema back-off has elapsed — probing support once more');
  return true;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function classifyStatus(status: number): ProviderFailure {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'not_configured';
  return 'api_error';
}

/**
 * Whether a 400 says the model cannot do schema-constrained decoding.
 *
 * Both halves are required. Naming `json_schema` alone is not enough: the
 * request contains that word, so an error that merely quotes what was sent
 * matches — as does a genuine complaint that our schema is malformed, which is
 * a bug to fix rather than a capability to give up. Requiring a refusal word
 * alongside it keeps this to what it claims to detect.
 */
const SCHEMA_TOPIC = /json_schema|response_format|structured output/;
const REFUSAL = /unsupported|not supported|does not support|unrecognized|invalid/;

export function isStructuredOutputRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lowered = body.toLowerCase();
  return SCHEMA_TOPIC.test(lowered) && REFUSAL.test(lowered);
}

export class GroqAssistantProvider implements AssistantProvider {
  readonly name = 'groq';

  private readonly model: string;

  constructor() {
    this.model = env.ASSISTANT_MODEL ?? DEFAULT_MODEL;
  }

  async generate(input: GenerateInput): Promise<ProviderResult> {
    if (!env.GROQ_API_KEY) return { ok: false, reason: 'not_configured' };

    const first = await this.call(input, structuredOutputAvailable());

    // A model that does not do schema-constrained decoding says so once; after
    // that every request asks for a plain JSON object and leans on the prompt.
    if (first.retryWithoutSchema) {
      schemaDisabledUntil = Date.now() + SCHEMA_RETRY_AFTER_MS;
      logger.warn(
        { model: this.model, retryAfterMs: SCHEMA_RETRY_AFTER_MS },
        'Model rejected json_schema — falling back to prompt-described schema for now',
      );
      const second = await this.call(input, false);
      return second.result;
    }

    return first.result;
  }

  private async call(
    input: GenerateInput,
    useStructuredOutput: boolean,
  ): Promise<{ result: ProviderResult; retryWithoutSchema: boolean }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), env.ASSISTANT_TIMEOUT_MS);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: env.ASSISTANT_MAX_TOKENS,
      // Not zero, for the reason the NVIDIA provider gives at length: this call
      // both extracts a decision and writes the sentence a customer reads, and
      // greedy decoding optimises for the first at the expense of the second.
      // The facts are protected by the grounding validator, not by determinism.
      temperature: env.ASSISTANT_TEMPERATURE,
      stream: false,
      messages: [
        { role: 'system', content: `${input.systemPrompt}\n\n${schemaInstruction(input.schema)}` },
        { role: 'user', content: input.userPrompt },
      ],
      response_format: useStructuredOutput
        ? {
            type: 'json_schema',
            json_schema: { name: 'assistant_decision', schema: input.schema, strict: true },
          }
        : { type: 'json_object' },
    };

    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');

        if (useStructuredOutput && isStructuredOutputRejection(response.status, errorBody)) {
          return { result: { ok: false, reason: 'api_error' }, retryWithoutSchema: true };
        }

        logger.error(
          { status: response.status, body: errorBody.slice(0, 500), model: this.model },
          'Groq returned non-OK status for the assistant',
        );
        return {
          result: { ok: false, reason: classifyStatus(response.status) },
          retryWithoutSchema: false,
        };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      const text = choice?.message?.content;

      // Cut off mid-object: the JSON cannot be complete, so say why rather than
      // reporting it as unparseable and leaving the token cap unexamined.
      if (choice?.finish_reason === 'length') {
        logger.warn(
          { maxTokens: env.ASSISTANT_MAX_TOKENS },
          'Groq hit the token cap — raise ASSISTANT_MAX_TOKENS',
        );
        return { result: { ok: false, reason: 'truncated' }, retryWithoutSchema: false };
      }

      if (typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({ data }, 'Groq response had no content');
        return { result: { ok: false, reason: 'api_error' }, retryWithoutSchema: false };
      }

      return {
        result: {
          ok: true,
          generation: {
            text,
            model: data.model ?? this.model,
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
          },
        },
        retryWithoutSchema: false,
      };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return { result: { ok: false, reason: 'timeout' }, retryWithoutSchema: false };
      }

      logger.error({ error }, 'Groq assistant request failed');
      return { result: { ok: false, reason: 'api_error' }, retryWithoutSchema: false };
    }
  }
}
