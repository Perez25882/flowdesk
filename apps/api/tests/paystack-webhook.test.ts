import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src/services/billing/paystack.js';

/**
 * Paystack webhook signature verification.
 *
 * The handler previously hashed `JSON.stringify(request.body)` rather than the
 * bytes Paystack sent. That passes for plain ASCII payloads and fails for
 * anything else, so billing broke only for the customers whose names carry an
 * accent — the exact failure these tests pin down.
 */

const SECRET = 'sk_test_dummy';

function sign(body: string | Buffer): string {
  return crypto.createHmac('sha512', SECRET).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature over the exact bytes received', () => {
    const raw = '{"event":"charge.success","data":{"reference":"ref_1"}}';
    expect(verifyWebhookSignature(Buffer.from(raw), sign(raw))).toBe(true);
  });

  it('accepts a Buffer and the equivalent string identically', () => {
    const raw = '{"event":"charge.success"}';
    const signature = sign(raw);

    expect(verifyWebhookSignature(raw, signature)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(raw), signature)).toBe(true);
  });

  it('rejects a body that was re-serialised rather than passed through', () => {
    // Paystack escapes non-ASCII; JSON.parse -> JSON.stringify does not put the
    // escape back. Same object, different bytes, different digest.
    const onTheWire = '{"customer":{"first_name":"Ren\\u00e9e"}}';
    const signature = sign(onTheWire);

    const reSerialised = JSON.stringify(JSON.parse(onTheWire));

    expect(reSerialised).not.toBe(onTheWire);
    expect(verifyWebhookSignature(onTheWire, signature)).toBe(true);
    expect(verifyWebhookSignature(reSerialised, signature)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const raw = '{"event":"charge.success","data":{"amount":500000}}';
    const signature = sign(raw);
    const tampered = '{"event":"charge.success","data":{"amount":100}}';

    expect(verifyWebhookSignature(tampered, signature)).toBe(false);
  });

  it('rejects a signature of the wrong length instead of throwing', () => {
    const raw = '{}';
    expect(verifyWebhookSignature(raw, 'abc123')).toBe(false);
    expect(verifyWebhookSignature(raw, '')).toBe(false);
  });

  it('rejects a non-hex signature instead of throwing', () => {
    const raw = '{}';
    // Right length, wrong alphabet — Buffer.from would silently truncate this.
    expect(verifyWebhookSignature(raw, 'z'.repeat(128))).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const raw = '{"event":"charge.success"}';
    const foreign = crypto.createHmac('sha512', 'sk_test_other').update(raw).digest('hex');

    expect(verifyWebhookSignature(raw, foreign)).toBe(false);
  });
});
