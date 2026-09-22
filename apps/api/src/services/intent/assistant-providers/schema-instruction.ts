/**
 * Says in the prompt what guided decoding would otherwise enforce.
 *
 * Belt and braces: on a model without schema-constrained decoding this is the
 * only thing shaping the output, and on a model with it the cost is a few
 * hundred tokens.
 *
 * Shared across providers deliberately. The wording below was arrived at by
 * reading a failed eval, not by reasoning, and a second provider writing its own
 * version would rediscover the same failure the same expensive way.
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    'Reply with a single JSON object and nothing else — no prose, no markdown fences.',
    // "It must match this schema exactly" was, to an 8B model, an instruction it
    // could satisfy by printing the schema. It did, on 10 of 22 messages in the
    // eval — and a decision that fails to parse falls through to the canned
    // template, so nearly half of all customers were answered by a form letter
    // while the logs showed the assistant "running". Naming the distinction
    // between a schema and an instance of one fixes it.
    'Output an INSTANCE of the schema below — the filled-in object with real values.',
    'Do NOT output the schema itself. A reply containing "type", "properties" or',
    '"required" as top-level keys is wrong.',
    'The schema:',
    JSON.stringify(schema),
  ].join('\n');
}
