#!/usr/bin/env node
/**
 * Points the Meta app's webhook at the current tunnel and subscribes the
 * WhatsApp Business Account to it, then reads the configuration back.
 *
 * Every value it prints is non-secret: ids, phone numbers, subscription
 * fields. Tokens are read from the root .env and never echoed.
 *
 *   node qa/meta-wire.mjs --callback https://<host>/api/v1/webhook
 *   node qa/meta-wire.mjs --check          # read current state, change nothing
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const checkOnly = argv.includes('--check');

const V = env.META_API_VERSION || 'v25.0';
const G = `https://graph.facebook.com/${V}`;
const APP_ID = env.META_APP_ID;
const APP_SECRET = env.META_APP_SECRET;
const TOKEN = env.META_ACCESS_TOKEN;
const PHONE_ID = env.META_PHONE_NUMBER_ID;
const VERIFY = env.META_VERIFY_TOKEN;
const APP_TOKEN = `${APP_ID}|${APP_SECRET}`;

const callback =
  arg('callback') ||
  `${(env.FRONTEND_URL || '').split(',')[0].replace(/\/$/, '')}/api/v1/webhook`;

async function graph(path, { method = 'GET', token, form } = {}) {
  const url = new URL(`${G}${path}`);
  const init = { method, headers: {} };
  if (method === 'GET') {
    url.searchParams.set('access_token', token);
  } else {
    const body = new URLSearchParams({ ...form, access_token: token });
    init.body = body;
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

const show = (label, r) =>
  console.log(`${label}: ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);

console.log(`api version   ${V}`);
console.log(`callback url  ${callback}`);
console.log('');

const dbg = await graph(
  `/debug_token?input_token=${encodeURIComponent(TOKEN)}`,
  { token: APP_TOKEN },
);
const d = dbg.json.data || {};
console.log(
  `token         app=${d.app_id} type=${d.type} valid=${d.is_valid} expires=${
    d.expires_at === 0 ? 'never' : new Date((d.expires_at || 0) * 1000).toISOString()
  }`,
);
if (d.scopes) console.log(`scopes        ${d.scopes.join(', ')}`);
if (!d.is_valid) {
  console.log('token is not valid — stopping');
  process.exit(1);
}

const phone = await graph(
  `/${PHONE_ID}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
  { token: TOKEN },
);
show('phone        ', phone);

let waba = arg('waba-id') || env.META_WABA_ID || null;
if (!waba) {
  const owned = await graph(`/${APP_ID}/subscriptions`, { token: APP_TOKEN });
  const biz = await graph(`/${PHONE_ID}?fields=whatsapp_business_account`, { token: TOKEN });
  waba = biz.json?.whatsapp_business_account?.id || null;
  if (!waba) show('waba lookup  ', biz);
  void owned;
}
console.log(`waba id       ${waba ?? '(not discoverable from this token)'}`);
console.log('');

if (!checkOnly) {
  const sub = await graph(`/${APP_ID}/subscriptions`, {
    method: 'POST',
    token: APP_TOKEN,
    form: {
      object: 'whatsapp_business_account',
      callback_url: callback,
      verify_token: VERIFY,
      fields: 'messages',
      include_values: 'true',
    },
  });
  show('set webhook  ', sub);

  if (waba) {
    const app = await graph(`/${waba}/subscribed_apps`, { method: 'POST', token: TOKEN });
    show('subscribe wab', app);
  }
}

show('app subs     ', await graph(`/${APP_ID}/subscriptions`, { token: APP_TOKEN }));
if (waba) {
  show('waba subs    ', await graph(`/${waba}/subscribed_apps`, { token: TOKEN }));
}
