import { describe, expect, it } from 'vitest';
import { trustProxyValue } from '../src/config/env.js';

/**
 * `trustProxy` parsing.
 *
 * Blanket `trustProxy: true` made `request.ip` derive from a client-supplied
 * X-Forwarded-For header, so the rate limiter and the credential brute-force
 * limiter keyed on it could be reset by rotating the header (proven live). The
 * default is now OFF, with explicit opt-in for a known proxy topology.
 */
describe('trustProxyValue', () => {
  it('defaults to false when unset — the safe default', () => {
    expect(trustProxyValue(undefined)).toBe(false);
  });

  it('treats "false" (any case) as false', () => {
    expect(trustProxyValue('false')).toBe(false);
    expect(trustProxyValue('FALSE')).toBe(false);
  });

  it('accepts an explicit "true" only when the operator opts in', () => {
    expect(trustProxyValue('true')).toBe(true);
  });

  it('parses a hop count', () => {
    expect(trustProxyValue('1')).toBe(1);
    expect(trustProxyValue('2')).toBe(2);
    expect(trustProxyValue('0')).toBe(0);
  });

  it('parses a comma-separated IP/CIDR allowlist', () => {
    expect(trustProxyValue('10.0.0.1, 192.168.0.0/16')).toEqual([
      '10.0.0.1',
      '192.168.0.0/16',
    ]);
  });

  it('never returns true for an unrecognised value — fails safe', () => {
    // A typo must not accidentally enable full header trust.
    const result = trustProxyValue('yes');
    expect(result).not.toBe(true);
    expect(result).toEqual(['yes']);
  });
});
