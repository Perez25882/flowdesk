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
 * NVIDIA NIM, via its OpenAI-compatible chat-completions endpoint.
 *
 * Two things make an open model workable for this job:
 *
 *   **Guided decoding.** NIM exposes vLLM's `guided_json` through `nvext`, which
 *   constrains generation to the schema rather than asking nicely for it. Not
 *   every hosted model supports it, so the first rejection turns it off for the
 *   process and the request is retried plain — self-healing, no configuration.
 *
 *   **Everything downstream assumes the model is fallible anyway.** The reply is
 *   Zod-parsed, its citations are checked against rows the server supplied, and
 *   every figure is verified before it may be sent. A weaker model produces more
 *   drafts, not more wrong answers.
 */

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * Chosen on measured latency, not on size.
 *
 * History matters here, because it will repeat. `meta/llama-3.3-70b-instruct`
 * was the obvious first pick and was unusable on the shared tier: 46s for one
 * decision and 503 `ResourceExhausted` under no load. `meta/llama-3.1-8b-instruct`
 * replaced it and answered in 2–4s — until NVIDIA retired it on 2026-08-26,
 * after which every request returned 410 Gone. The assistant degraded to canned
 * templates for six days, and nothing failed loudly enough for anyone to notice.
 *
 * Re-measured 2026-09-01 with `qa/nv-pick.mjs`, which sends this exact request
 * shape. Of eight candidates only this one was usable: 4/4 valid JSON at ~6.4s.
 * Kimi K3, Gemma 4 and DeepSeek V4 Flash each timed out past 75s; the Nemotron
 * nano and lightning variants returned nothing parseable. It rejects
 * `guided_json`, which costs one 400 on the first call and nothing afterwards.
 *
 * When this one is retired too, re-run `node qa/nv-pick.mjs` rather than
 * guessing: the NVIDIA catalogue turns over faster than this comment does.
 *
 * Override with ASSISTANT_MODEL if you have dedicated capacity for a larger one.
 */
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

/**
 * Turned off for the rest of the process the first time a model rejects it.
 * Per-process rather than per-request so one 400 is the whole cost of finding out.
 */
let guidedJsonSupported = true;

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// `schemaInstruction` now lives in ./schema-instruction.ts, shared with the Groq
// provider. Its wording came out of a failed eval rather than reasoning, so it
// is worth one import to stop a second provider rediscovering it the hard way.

function classifyStatus(status: number): ProviderFailure {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'api_error';
  return 'api_error';
}

/** Whether a 400 is complaining about the `nvext` block specifically. */
function isGuidedJsonRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lowered = body.toLowerCase();
  return (
    lowered.includes('nvext') ||
    lowered.includes('guided_json') ||
    lowered.includes('guided decoding')
  );
}

export class NvidiaAssistantProvider implements AssistantProvider {
  readonly name = 'nvidia';

  private readonly model: string;

  constructor() {
    this.model = env.ASSISTANT_MODEL ?? DEFAULT_MODEL;
  }

  async generate(input: GenerateInput): Promise<ProviderResult> {
    if (!env.NVIDIA_API_KEY) return { ok: false, reason: 'not_configured' };

    const first = await this.call(input, guidedJsonSupported);

    // A model that does not do guided decoding says so once; after that every
    // request goes plain and leans on the prompt instead.
    if (first.retryWithoutGuidance) {
      guidedJsonSupported = false;
      logger.warn(
        { model: this.model },
        'Model rejected guided JSON — falling back to prompt-described schema',
      );
      const second = await this.call(input, false);
      return second.result;
    }

    return first.result;
  }

  private async call(
    input: GenerateInput,
    useGuidedJson: boolean,
  ): Promise<{ result: ProviderResult; retryWithoutGuidance: boolean }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), env.ASSISTANT_TIMEOUT_MS);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: env.ASSISTANT_MAX_TOKENS,
      // Not zero. This call does two jobs at once — it extracts a decision and
      // it writes the sentence a customer reads — and greedy decoding optimises
      // for the first at the expense of the second: the same flat clause every
      // time, "A bag of rice costs GHS 450.00", no matter who asked or how.
      //
      // The facts are not protected by determinism anyway. They are protected
      // by the grounding validator, which checks the figures in the finished
      // text against the rows that were retrieved, and by `applyServerInvariants`
      // before it. Sampling changes the wording, not what may be asserted.
      temperature: env.ASSISTANT_TEMPERATURE,
      stream: false,
      messages: [
        { role: 'system', content: `${input.systemPrompt}\n\n${schemaInstruction(input.schema)}` },
        { role: 'user', content: input.userPrompt },
      ],
      response_format: { type: 'json_object' },
    };

    if (useGuidedJson) {
      body.nvext = { guided_json: input.schema };
    }

    try {
      const response = await fetch(NVIDIA_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');

        if (useGuidedJson && isGuidedJsonRejection(response.status, errorBody)) {
          return { result: { ok: false, reason: 'api_error' }, retryWithoutGuidance: true };
        }

        logger.error(
          { status: response.status, body: errorBody.slice(0, 500), model: this.model },
          'NVIDIA NIM returned non-OK status for the assistant',
        );
        return {
          result: { ok: false, reason: classifyStatus(response.status) },
          retryWithoutGuidance: false,
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
          'NVIDIA NIM hit the token cap — raise ASSISTANT_MAX_TOKENS',
        );
        return { result: { ok: false, reason: 'truncated' }, retryWithoutGuidance: false };
      }

      if (typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({ data }, 'NVIDIA NIM response had no content');
        return { result: { ok: false, reason: 'api_error' }, retryWithoutGuidance: false };
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
        retryWithoutGuidance: false,
      };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return { result: { ok: false, reason: 'timeout' }, retryWithoutGuidance: false };
      }

      logger.error({ error }, 'NVIDIA NIM assistant request failed');
      return { result: { ok: false, reason: 'api_error' }, retryWithoutGuidance: false };
    }
  }
}

/** Test seam — the guided-JSON probe is process-wide state. */
export function resetGuidedJsonProbeForTests(): void {
  guidedJsonSupported = true;
}
