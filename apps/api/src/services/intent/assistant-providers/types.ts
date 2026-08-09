/**
 * What the assistant needs from a model vendor, and nothing more.
 *
 * A provider's only job is: take a system prompt, a user prompt and a JSON
 * schema, and come back with text that should be that JSON. It does no parsing,
 * no validation and no routing — those are shared, because they are the parts
 * that keep a wrong answer away from a customer and must not vary by vendor.
 *
 * The practical consequence: swapping vendors cannot weaken the guardrails. A
 * model that returns worse decisions produces more drafts, not more mistakes.
 */

export interface AssistantGeneration {
  /** Raw text from the model. Expected to be JSON; not yet trusted to be. */
  text: string;
  /** The model that actually answered, which may differ from the one requested. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type ProviderFailure =
  | 'not_configured'
  | 'timeout'
  | 'rate_limited'
  | 'refused'
  | 'truncated'
  | 'api_error';

export type ProviderResult =
  | { ok: true; generation: AssistantGeneration }
  | { ok: false; reason: ProviderFailure };

export interface GenerateInput {
  systemPrompt: string;
  userPrompt: string;
  /** The shape the answer must take. How it is enforced is the provider's business. */
  schema: Record<string, unknown>;
}

export interface AssistantProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<ProviderResult>;
}
