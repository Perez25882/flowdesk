import { describe, expect, it } from 'vitest';
import { classifyMetaError, describeForOwner } from '../src/services/whatsapp/meta-errors.js';

function metaError(code: number, message = 'error'): string {
  return JSON.stringify({ error: { code, message } });
}

/**
 * Misclassifying a Meta failure has real consequences: retrying a revoked token
 * burns quota forever and never recovers, while giving up on a throttle drops a
 * customer's order confirmation.
 */
describe('classifyMetaError', () => {
  it('treats auth failures as a connection problem needing the owner', () => {
    const failure = classifyMetaError(401, metaError(190, 'Access token has expired'));

    expect(failure.kind).toBe('TOKEN_INVALID');
    expect(failure.retryable).toBe(false);
    expect(failure.connectionState).toBe('TOKEN_INVALID');
  });

  it('treats an unusable number as a connection problem', () => {
    const failure = classifyMetaError(400, metaError(133005));

    expect(failure.kind).toBe('NUMBER_UNAVAILABLE');
    expect(failure.retryable).toBe(false);
    expect(failure.connectionState).toBe('NUMBER_UNAVAILABLE');
  });

  it('marks throttling retryable so the message is not lost', () => {
    const failure = classifyMetaError(429, metaError(80007));

    expect(failure.kind).toBe('RATE_LIMITED');
    expect(failure.retryable).toBe(true);
  });

  it('does not retry a message rejected for being outside the 24-hour window', () => {
    // Retrying cannot help — only an approved template is permitted there.
    const failure = classifyMetaError(400, metaError(131047));

    expect(failure.kind).toBe('REENGAGEMENT_REQUIRED');
    expect(failure.retryable).toBe(false);
    expect(failure.connectionState).toBeNull();
  });

  it('does not blame the connection when one recipient is unreachable', () => {
    const failure = classifyMetaError(400, metaError(131026));

    expect(failure.kind).toBe('RECIPIENT_UNAVAILABLE');
    expect(failure.retryable).toBe(false);
    // Critically null: one bad number must not disable the whole tenant.
    expect(failure.connectionState).toBeNull();
  });

  it('retries Meta-side faults', () => {
    expect(classifyMetaError(500, metaError(131000)).retryable).toBe(true);
    expect(classifyMetaError(503, '<html>gateway</html>').kind).toBe('TRANSIENT');
  });

  it('falls back to HTTP status when the body is unparseable', () => {
    expect(classifyMetaError(401, 'not json').kind).toBe('TOKEN_INVALID');
    expect(classifyMetaError(429, '').kind).toBe('RATE_LIMITED');
  });

  it('treats an unrecognised code as retryable rather than silently dropping it', () => {
    const failure = classifyMetaError(400, metaError(999_999));

    expect(failure.kind).toBe('UNKNOWN');
    expect(failure.retryable).toBe(true);
  });

  it('keeps Meta’s message for diagnostics', () => {
    const failure = classifyMetaError(400, metaError(190, 'Session has been invalidated'));

    expect(failure.message).toContain('Session has been invalidated');
    expect(failure.code).toBe(190);
  });
});

describe('describeForOwner', () => {
  it('gives an actionable instruction for every failure the owner can fix', () => {
    expect(describeForOwner('TOKEN_INVALID')).toMatch(/reconnect/i);
    expect(describeForOwner('NUMBER_UNAVAILABLE')).toMatch(/Business Manager/i);
    expect(describeForOwner('RATE_LIMITED')).toMatch(/automatically/i);
  });

  it('never leaks a raw error code to the owner', () => {
    for (const kind of [
      'TOKEN_INVALID',
      'NUMBER_UNAVAILABLE',
      'RATE_LIMITED',
      'REENGAGEMENT_REQUIRED',
      'RECIPIENT_UNAVAILABLE',
      'TRANSIENT',
      'UNKNOWN',
    ] as const) {
      expect(describeForOwner(kind)).not.toMatch(/\d{5,}/);
    }
  });
});
