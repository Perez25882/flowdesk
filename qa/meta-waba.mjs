#!/usr/bin/env node
/** Finds the WhatsApp Business Account behind the configured phone number. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const V = env.META_API_VERSION || 'v25.0';
const G = `https://graph.facebook.com/${V}`;
const APP = `${env.META_APP_ID}|${env.META_APP_SECRET}`;
const T = env.META_ACCESS_TOKEN;

async function get(path, token) {
  const url = new URL(`${G}${path}`);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 200) } };
  }
}
const p = (l, r) => console.log(`${l.padEnd(30)} ${r.status} ${JSON.stringify(r.json).slice(0, 500)}`);

p('/me', await get('/me?fields=id,name', T));
p('app owned wabas', await get(`/${env.META_APP_ID}/owned_whatsapp_business_accounts`, APP));
p('app client wabas', await get(`/${env.META_APP_ID}/client_whatsapp_business_accounts`, APP));
p('phone fields', await get(`/${env.META_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,name_status,is_official_business_account,messaging_limit_tier`, T));
