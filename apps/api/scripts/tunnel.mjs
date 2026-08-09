#!/usr/bin/env node
/**
 * Opens a public HTTPS tunnel so Meta can deliver webhooks to this machine.
 *
 * Meta only calls an endpoint it can reach from the internet, which localhost
 * is not. This wraps ngrok (preferred — the account has a reserved domain, so
 * the URL survives restarts and does not have to be re-pasted into the Meta
 * console) and falls back to a cloudflared quick tunnel if ngrok is missing.
 *
 * The tunnel points at the WEB dev server, not the API. Vite proxies `/api/v1`
 * through to the API, so a single public URL serves both the dashboard and the
 * webhook endpoint — and Embedded Signup, which requires the page itself to be
 * HTTPS, works from the same origin.
 *
 * Usage:
 *   node scripts/tunnel.mjs                 # tunnel the web app (default)
 *   node scripts/tunnel.mjs --port 3000     # tunnel the API directly
 *   node scripts/tunnel.mjs --provider cloudflared
 * Stop: Ctrl-C
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_PATH = join(ROOT, '.env');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

/** Web dev server: Vite proxies /api/v1 to the API from here. */
const DEFAULT_PORT = '5173';

const NGROK_CANDIDATES = [
  join(
    homedir(),
    'AppData\\Local\\Microsoft\\WinGet\\Packages',
    'Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ngrok.exe',
  ),
  'C:\\Program Files\\ngrok\\ngrok.exe',
  'ngrok',
];

const CLOUDFLARED_CANDIDATES = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'cloudflared',
];

function findBinary(candidates) {
  for (const candidate of candidates) {
    // A bare name is assumed to be on PATH; spawn will report if it is not.
    if (!candidate.includes('\\') || existsSync(candidate)) return candidate;
  }
  return null;
}

function readEnvValue(key) {
  if (!existsSync(ENV_PATH)) return null;
  for (const line of readFileSync(ENV_PATH, 'utf8').replace(/\r/g, '').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === key) {
      return match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * The reserved ngrok domain, taken from FRONTEND_URL so there is one place to
 * change it. Without a reserved domain ngrok issues a random URL that must be
 * re-pasted into the Meta console after every restart.
 */
function reservedDomain() {
  const explicit = arg('domain');
  if (explicit) return explicit;

  const frontend = readEnvValue('FRONTEND_URL') ?? '';
  const match = frontend.match(/https:\/\/([a-z0-9-]+\.ngrok[a-z0-9.-]*)/i);
  return match ? match[1] : null;
}

const port = arg('port', DEFAULT_PORT);
const provider = arg('provider', 'auto');

function announce(publicUrl) {
  const verifyToken = readEnvValue('META_VERIFY_TOKEN');

  console.log(`\n${GREEN}Tunnel is live.${RESET}\n`);
  console.log(`  Dashboard      ${BOLD}${publicUrl}${RESET}`);
  console.log('');
  console.log(`${BOLD}Paste these into Meta → WhatsApp → Configuration → Webhooks${RESET}\n`);
  console.log(`  Callback URL   ${BOLD}${publicUrl}/api/v1/webhook${RESET}`);
  console.log(
    `  Verify token   ${BOLD}${verifyToken ?? '(missing — check META_VERIFY_TOKEN in .env)'}${RESET}\n`,
  );
  console.log(`${DIM}  Then click "Verify and save" and subscribe to the "messages" field.${RESET}`);
  console.log(`${DIM}  Leave this running. Ctrl-C to stop.${RESET}\n`);
}

function startNgrok(binary) {
  const domain = reservedDomain();

  const args = ['http', port, '--log=stdout'];
  if (domain) {
    args.push(`--url=${domain}`);
  } else {
    console.log(
      `${YELLOW}No reserved domain found in FRONTEND_URL — ngrok will issue a random URL${RESET}`,
    );
    console.log(`${DIM}that must be re-pasted into Meta after every restart.${RESET}\n`);
  }

  console.log(`${BOLD}Starting ngrok → http://localhost:${port}${RESET}`);

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let announced = false;

  const inspect = (chunk) => {
    const text = chunk.toString();

    const url = text.match(/url=(https:\/\/[^\s"]+)/);
    if (url && !announced) {
      announced = true;
      announce(url[1]);
    }

    // ngrok reports a taken domain or a second agent session as an error.
    const err = text.match(/err="([^"]+)"/);
    if (err && !/already/i.test(err[1])) {
      process.stderr.write(`${DIM}${err[1]}${RESET}\n`);
    }

    if (/ERR_NGROK_108/.test(text)) {
      console.error(
        `\n${RED}Another ngrok agent is already running.${RESET} The free plan allows one.`,
      );
      console.error('Stop it, or visit http://127.0.0.1:4040 to see the existing tunnel.\n');
    }
  };

  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  return child;
}

function startCloudflared(binary) {
  console.log(`${BOLD}Starting cloudflared → http://localhost:${port}${RESET}`);
  console.log(`${DIM}Quick tunnels get a new URL each run; ngrok with a reserved`);
  console.log(`domain avoids re-pasting it into Meta.${RESET}`);

  const child = spawn(binary, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let announced = false;

  const inspect = (chunk) => {
    const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !announced) {
      announced = true;
      announce(match[0]);
    }
  };

  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  return child;
}

const ngrok = provider === 'cloudflared' ? null : findBinary(NGROK_CANDIDATES);
const cloudflared = ngrok ? null : findBinary(CLOUDFLARED_CANDIDATES);

if (!ngrok && !cloudflared) {
  console.error(`\n${RED}No tunnel tool found.${RESET}`);
  console.error('Install one:');
  console.error('  winget install Ngrok.Ngrok            (recommended)');
  console.error('  winget install Cloudflare.cloudflared\n');
  process.exit(1);
}

const child = ngrok ? startNgrok(ngrok) : startCloudflared(cloudflared);

child.on('exit', (code) => {
  console.log(`\nTunnel closed${code === 0 ? '' : ` (exit ${code})`}.`);
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
}
