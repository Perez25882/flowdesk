import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

export function requireLoopbackUrl(value, name, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid loopback URL`);
  }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} must use ${protocols.join(' or ')} on loopback`);
  }
  return url;
}

export function smokeConfig(environment = process.env) {
  const fromFile = environment.SMOKE_ENV_FILE ? parse(readFileSync(environment.SMOKE_ENV_FILE)) : {};
  const env = { ...fromFile, ...environment };
  const base = requireLoopbackUrl(env.API_URL ?? 'http://127.0.0.1:3000', 'API_URL', ['http:']);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('API_URL must be a loopback HTTP origin');
  }
  if (!env.META_WEBHOOK_SECRET || env.META_WEBHOOK_SECRET.trim().length < 32) {
    throw new Error('META_WEBHOOK_SECRET must contain at least 32 characters for synthetic signing');
  }
  return { apiOrigin: base.origin, webhookSecret: env.META_WEBHOOK_SECRET };
}
