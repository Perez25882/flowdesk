import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { smokeConfig } from '../scripts/smoke-config.mjs';

describe('synthetic smoke configuration', () => {
  const secret = 'flowdesk-synthetic-webhook-secret-000000';

  it.each(['\n', '\r\n'])('parses quoted fixture configuration with line ending %j', (eol) => {
    const dir = mkdtempSync(join(tmpdir(), 'flowdesk-smoke-env-'));
    try {
      const path = join(dir, '.env');
      writeFileSync(path, [`META_WEBHOOK_SECRET="${secret}"`, 'API_URL=http://127.0.0.1:3017', ''].join(eol));
      expect(smokeConfig({ SMOKE_ENV_FILE: path })).toEqual({
        apiOrigin: 'http://127.0.0.1:3017', webhookSecret: secret,
      });
      expect(smokeConfig({ SMOKE_ENV_FILE: path, API_URL: 'http://127.0.0.1:3018' }).apiOrigin).toBe('http://127.0.0.1:3018');
    } finally {
      rmSync(join(dir, '.env'), { force: true });
      rmdirSync(dir);
    }
  });

  it('fails before sending a request if the signing secret is absent', () => {
    expect(() => smokeConfig({})).toThrow('META_WEBHOOK_SECRET');
  });

  it('rejects non-loopback origins and URL credentials', () => {
    expect(() => smokeConfig({ META_WEBHOOK_SECRET: secret, API_URL: 'https://example.invalid' })).toThrow('loopback');
    expect(() => smokeConfig({ META_WEBHOOK_SECRET: secret, API_URL: 'http://user:pass@localhost:3017' })).toThrow('origin');
  });
});
