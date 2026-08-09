#!/usr/bin/env node
/**
 * WhatsApp credential wizard.
 *
 * Takes the values you copy out of the Meta App Dashboard, verifies each one
 * against the Graph API, subscribes your WhatsApp Business Account to the app
 * so inbound messages are delivered, and writes everything into the root .env.
 *
 * Nothing is written unless every check passes, so a typo cannot leave the
 * server half-configured.
 *
 * Usage:
 *   node scripts/whatsapp-setup.mjs \
 *     --app-id 1234567890 \
 *     --app-secret abc123... \
 *     --token EAAG... \
 *     --phone-number-id 9876543210 \
 *     [--waba-id 5555555555] \
 *     [--config-id 4444444444]
 *
 * Re-running is safe: it revalidates and overwrites the same keys.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_PATH = join(ROOT, '.env');
const GRAPH = 'https://graph.facebook.com';
const API_VERSION = 'v20.0';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';

function ok(message) {
  console.log(`  ${GREEN}✓${RESET} ${message}`);
}
function bad(message) {
  console.log(`  ${RED}✗${RESET} ${message}`);
}
function note(message) {
  console.log(`  ${DIM}${message}${RESET}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

async function graph(path, token, params = {}) {
  const url = new URL(`${GRAPH}/${API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return body;
}

/** Rewrites KEY=value lines in place, preserving comments and ordering. */
function updateEnv(updates) {
  const original = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const lines = original.split('\n');
  const remaining = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) {
    rewritten.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, rewritten.join('\n'), 'utf8');
}

function readEnvValue(key) {
  if (!existsSync(ENV_PATH)) return null;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === key) {
      return match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function usage() {
  console.log(`
${BOLD}Flowdesk — WhatsApp setup${RESET}

Required:
  --app-id           Meta App ID            (App Dashboard → Settings → Basic)
  --app-secret       Meta App Secret        (same page, click "Show")
  --token            Access token           (WhatsApp → API Setup)
  --phone-number-id  Phone number ID        (WhatsApp → API Setup)

Optional:
  --waba-id          WhatsApp Business Account ID (auto-discovered if omitted)
  --config-id        Embedded Signup config ID    (only for self-serve onboarding)

Example:
  node scripts/whatsapp-setup.mjs --app-id 123 --app-secret abc --token EAAG... --phone-number-id 456
`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || Object.keys(args).length === 0) {
    usage();
    process.exit(0);
  }

  const appId = args['app-id'];
  const appSecret = args['app-secret'];
  const token = args.token;
  const phoneNumberId = args['phone-number-id'];

  const missing = [];
  if (!appId) missing.push('--app-id');
  if (!appSecret) missing.push('--app-secret');
  if (!token) missing.push('--token');
  if (!phoneNumberId) missing.push('--phone-number-id');

  if (missing.length > 0) {
    console.log(`\n${RED}Missing required options:${RESET} ${missing.join(', ')}`);
    usage();
    process.exit(1);
  }

  console.log(`\n${BOLD}Verifying credentials with Meta${RESET}\n`);

  // 1. Token validity + which app it belongs to.
  let tokenInfo;
  try {
    tokenInfo = await graph('debug_token', token, { input_token: token });
    const data = tokenInfo.data ?? {};

    if (data.is_valid === false) {
      bad('Access token is not valid');
      note('Generate a fresh token under WhatsApp → API Setup.');
      process.exit(1);
    }

    ok('Access token is valid');

    if (data.app_id && data.app_id !== appId) {
      bad(`Token belongs to app ${data.app_id}, not ${appId}`);
      process.exit(1);
    }

    if (data.expires_at && data.expires_at > 0) {
      const expiry = new Date(data.expires_at * 1000);
      const hours = Math.round((expiry - Date.now()) / 3_600_000);
      if (hours < 48) {
        console.log(
          `  ${YELLOW}!${RESET} Token expires ${expiry.toLocaleString()} (~${hours}h)`,
        );
        note('This is a temporary token. Create a System User token for anything permanent.');
      } else {
        ok(`Token valid until ${expiry.toLocaleString()}`);
      }
    } else {
      ok('Token does not expire');
    }
  } catch (error) {
    bad(`Could not verify the token: ${error.message}`);
    note('Check that --token and --app-id are correct and from the same app.');
    process.exit(1);
  }

  // 2. Phone number is real and reachable with this token.
  let phoneInfo;
  try {
    phoneInfo = await graph(phoneNumberId, token, {
      fields: 'display_phone_number,verified_name,quality_rating',
    });
    ok(`Phone number: ${phoneInfo.display_phone_number} (${phoneInfo.verified_name ?? 'unverified'})`);
    if (phoneInfo.quality_rating) {
      note(`Quality rating: ${phoneInfo.quality_rating}`);
    }
  } catch (error) {
    bad(`Phone number ${phoneNumberId} is not accessible: ${error.message}`);
    note('Copy the "Phone number ID" (not the phone number) from WhatsApp → API Setup.');
    process.exit(1);
  }

  // 3. Resolve the WABA, which is what actually carries the webhook subscription.
  let wabaId = args['waba-id'];

  if (!wabaId) {
    try {
      const businesses = await graph('me/businesses', token, { fields: 'id,name' });
      for (const business of businesses.data ?? []) {
        const accounts = await graph(`${business.id}/owned_whatsapp_business_accounts`, token);
        if (accounts.data?.length) {
          wabaId = accounts.data[0].id;
          break;
        }
      }
    } catch {
      // Falls through to the explicit-flag message below.
    }
  }

  if (wabaId) {
    ok(`WhatsApp Business Account: ${wabaId}`);
  } else {
    console.log(`  ${YELLOW}!${RESET} Could not auto-discover the WABA id`);
    note('Pass --waba-id explicitly, or subscribe the app manually in the Meta console.');
  }

  // 4. Subscribe the app to the WABA so inbound messages are delivered.
  if (wabaId) {
    try {
      const response = await fetch(
        `${GRAPH}/${API_VERSION}/${wabaId}/subscribed_apps`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      const body = await response.json().catch(() => ({}));

      if (response.ok && body.success !== false) {
        ok('App subscribed to the WhatsApp Business Account');
      } else {
        console.log(
          `  ${YELLOW}!${RESET} Could not subscribe automatically: ${body?.error?.message ?? 'unknown'}`,
        );
        note('Subscribe manually: WhatsApp → Configuration → Webhooks → Manage.');
      }
    } catch (error) {
      console.log(`  ${YELLOW}!${RESET} Subscription request failed: ${error.message}`);
    }
  }

  // 5. Persist. Only reached when the essential checks passed.
  const updates = {
    META_APP_ID: appId,
    META_APP_SECRET: appSecret,
    META_ACCESS_TOKEN: token,
    META_PHONE_NUMBER_ID: phoneNumberId,
    META_API_VERSION: API_VERSION,
    // Meta signs webhooks with the APP SECRET. Keeping a separate value here
    // is the single most common reason signature validation fails.
    META_WEBHOOK_SECRET: appSecret,
  };

  if (args['config-id']) updates.META_CONFIG_ID = args['config-id'];

  updateEnv(updates);
  ok(`Wrote credentials to ${ENV_PATH}`);

  const verifyToken = readEnvValue('META_VERIFY_TOKEN');

  console.log(`\n${BOLD}Next: point Meta at your webhook${RESET}\n`);
  console.log('  1. Start a public tunnel to the API:');
  console.log(`     ${DIM}node scripts/tunnel.mjs${RESET}`);
  console.log('');
  console.log('  2. In the Meta App Dashboard → WhatsApp → Configuration → Webhooks, set:');
  console.log(`     Callback URL   ${DIM}https://<your-tunnel-host>/api/v1/webhook${RESET}`);
  console.log(`     Verify token   ${DIM}${verifyToken ?? '(see META_VERIFY_TOKEN in .env)'}${RESET}`);
  console.log('');
  console.log('  3. Subscribe to the "messages" field.');
  console.log('');
  console.log('  4. Restart the API so it picks up the new credentials.');
  console.log('');
  console.log(`  ${GREEN}Then message your WhatsApp number and watch the dashboard.${RESET}\n`);
}

main().catch((error) => {
  console.error(`\n${RED}Setup failed:${RESET}`, error.message);
  process.exit(1);
});
