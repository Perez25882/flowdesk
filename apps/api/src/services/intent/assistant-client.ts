import type { AssistantDecision } from '@flowdesk/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import {
  ASSISTANT_DECISION_JSON_SCHEMA,
  applyServerInvariants,
  parseDecision,
} from '../assistant/decision.js';
import type { EvidenceSet } from '../assistant/evidence.js';
import { AnthropicAssistantProvider } from './assistant-providers/anthropic.js';
import { NvidiaAssistantProvider } from './assistant-providers/nvidia.js';
import type { AssistantProvider, ProviderFailure } from './assistant-providers/types.js';

/**
 * The assistant call, and everything that makes its answer safe to act on.
 *
 * The vendor lives behind `AssistantProvider`; this module owns the parts that
 * must not vary by vendor:
 *
 *   - **Nothing self-granted.** The decision goes through `applyServerInvariants`
 *     before it leaves here, so a caller cannot act on an answer that cites
 *     evidence the server never supplied.
 *   - **Fails to a value, never a throw.** Every failure is a typed reason. A
 *     thrown error would fail the whole intent job and lose the rule engine's
 *     classification with it.
 *   - **Stops trying when the provider is down**, so an outage costs one slow
 *     request per minute rather than one per message.
 */

export type AssistantFailureReason = ProviderFailure | 'circuit_open' | 'malformed';

export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
  latencyMs: number;
}

export type AssistantResult =
  | { ok: true; decision: AssistantDecision; usage: AssistantUsage }
  | { ok: false; reason: AssistantFailureReason };

export interface AssistantRequest {
  systemPrompt: string;
  userPrompt: string;
  /** The rows the server put in the prompt. Nothing outside this may be cited. */
  evidence: EvidenceSet;
}

/**
 * Breaker state in Redis so every worker sees the same picture. The failure
 * being tracked is the provider's, not a tenant's, so the key is global: when
 * the API is down, one worker finding out should spare the rest.
 */
const BREAKER_OPEN_KEY = 'assistant:breaker:open';
const BREAKER_FAILURES_KEY = 'assistant:breaker:failures';
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_SECONDS = 60;
const BREAKER_WINDOW_SECONDS = 120;

/** Reasons that say something about the provider rather than about one message. */
const BREAKER_TRIPPING_REASONS: ReadonlySet<AssistantFailureReason> = new Set([
  'timeout',
  'rate_limited',
  'api_error',
]);

let cachedProvider: AssistantProvider | null = null;

function getProvider(): AssistantProvider {
  if (!cachedProvider) {
    cachedProvider =
      env.AI_PROVIDER === 'nvidia'
        ? new NvidiaAssistantProvider()
        : new AnthropicAssistantProvider();
  }
  return cachedProvider;
}

/**
 * Redis being unreachable must not take the assistant down with it, so a failed
 * check reads as "closed" and the call goes ahead. The breaker saves latency; it
 * is not a correctness mechanism.
 */
async function isCircuitOpen(): Promise<boolean> {
  try {
    return (await redis.exists(BREAKER_OPEN_KEY)) === 1;
  } catch {
    return false;
  }
}

async function recordFailure(reason: AssistantFailureReason): Promise<void> {
  if (!BREAKER_TRIPPING_REASONS.has(reason)) return;

  try {
    const failures = await redis.incr(BREAKER_FAILURES_KEY);
    if (failures === 1) {
      await redis.expire(BREAKER_FAILURES_KEY, BREAKER_WINDOW_SECONDS);
    }

    if (failures >= BREAKER_THRESHOLD) {
      await redis.set(BREAKER_OPEN_KEY, '1', 'EX', BREAKER_COOLDOWN_SECONDS);
      await redis.del(BREAKER_FAILURES_KEY);
      logger.error(
        { failures, cooldownSeconds: BREAKER_COOLDOWN_SECONDS },
        'Assistant circuit breaker opened — falling back to drafts',
      );
    }
  } catch {
    logger.warn('Failed to record assistant failure against the circuit breaker');
  }
}

async function recordSuccess(): Promise<void> {
  try {
    await redis.del(BREAKER_FAILURES_KEY);
  } catch {
    // A stale count costs at most one premature open, which expires on its own.
  }
}

/**
 * Pulls the JSON object out of a reply that may not be only JSON.
 *
 * Guided decoding makes this unnecessary; prompt-described schemas do not. Open
 * models routinely wrap the object in a markdown fence or a sentence of
 * introduction, and discarding an otherwise correct decision over a fence would
 * mean drafting everything.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();

  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // Widest span between the first `{` and the last `}` — the object itself when
  // the model has written something either side of it.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next shape.
    }
  }

  return null;
}

function fail(reason: AssistantFailureReason): AssistantResult {
  return { ok: false, reason };
}

export async function requestAssistantDecision(
  request: AssistantRequest,
): Promise<AssistantResult> {
  if (await isCircuitOpen()) return fail('circuit_open');

  const provider = getProvider();
  const startedAt = Date.now();

  const result = await provider.generate({
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    schema: ASSISTANT_DECISION_JSON_SCHEMA,
  });

  if (!result.ok) {
    // Not a provider fault, and tripping the breaker on it would disable the
    // assistant for everyone because one deployment has no key.
    if (result.reason !== 'not_configured') {
      await recordFailure(result.reason);
    }
    return fail(result.reason);
  }

  const latencyMs = Date.now() - startedAt;
  const raw = extractJsonObject(result.generation.text);

  if (raw === null) {
    logger.warn(
      { provider: provider.name, sample: result.generation.text.slice(0, 200) },
      'Assistant returned no parseable JSON object',
    );
    await recordFailure('malformed');
    return fail('malformed');
  }

  const parsed = parseDecision(raw);
  if (!parsed) {
    logger.warn(
      { provider: provider.name, raw },
      'Assistant returned JSON that does not match the decision contract',
    );
    await recordFailure('malformed');
    return fail('malformed');
  }

  await recordSuccess();

  return {
    ok: true,
    decision: applyServerInvariants(parsed, request.evidence),
    usage: {
      inputTokens: result.generation.inputTokens,
      outputTokens: result.generation.outputTokens,
      model: result.generation.model,
      provider: provider.name,
      latencyMs,
    },
  };
}

/** Test seam — the provider is chosen once and cached. */
export function resetAssistantClientForTests(): void {
  cachedProvider = null;
}
