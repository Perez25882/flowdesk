import { describe, expect, it } from 'vitest';
import { isStructuredOutputRejection } from '../src/services/intent/assistant-providers/groq.js';

/**
 * When to stop asking Groq for schema-constrained decoding.
 *
 * This matters more than its size suggests. Constrained decoding is what makes
 * the decision schema binding; give it up wrongly and every reply afterwards is
 * prompt-only JSON, which is how a run of malformed decisions started last
 * time. The tests below are mostly about NOT giving it up.
 */
describe('isStructuredOutputRejection', () => {
  it('recognises a model that genuinely cannot do it', () => {
    expect(
      isStructuredOutputRejection(400, '{"error":{"message":"response_format json_schema is not supported for this model"}}'),
    ).toBe(true);
    expect(
      isStructuredOutputRejection(400, '{"error":{"message":"Unsupported value: response_format"}}'),
    ).toBe(true);
  });

  it('does not give up because the error quoted the request back', () => {
    // The request body contains the words. An error that echoes it is not a
    // statement about capability.
    expect(
      isStructuredOutputRejection(
        400,
        '{"error":{"message":"Request too large","failed_generation":"response_format json_schema"}}',
      ),
    ).toBe(false);
  });

  it('does not give up on a rate limit or a server error', () => {
    expect(isStructuredOutputRejection(429, 'rate limit exceeded for json_schema requests')).toBe(false);
    expect(isStructuredOutputRejection(500, 'internal error: response_format unsupported')).toBe(false);
    expect(isStructuredOutputRejection(503, 'service unavailable')).toBe(false);
  });

  it('does give up on a 422, which is the other status Groq uses for this', () => {
    expect(isStructuredOutputRejection(422, 'invalid response_format for this model')).toBe(true);
  });
});
