/**
 * Simulates an inbound WhatsApp webhook delivery to the local API.
 *
 * Hits POST `${API_URL}/api/v1/webhook` with a real Meta-shaped payload
 * signed with HMAC-SHA256 using `META_WEBHOOK_SECRET`. The receiving API
 * does not know the difference.
 *
 * Use to exercise the full pipeline:
 *   inbound webhook → message persisted → intent classified (worker) → order
 *   created (if intent=ORDER + confidence threshold met) → SSE event → UI.
 *
 * Run via:
 *   pnpm simulate:msg --text "I want 2 bags tomatoes"
 *   pnpm simulate:msg --text "Hello"           # → INQUIRY (low confidence)
 *   pnpm simulate:msg --text "thanks"          # → COMPLAINT bucket
 *   pnpm simulate:msg --text "..." --from 233241234567 --name "Kwame"
 */
import crypto from 'node:crypto';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// apps/api/scripts -> apps/api -> apps -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../..');
// The root .env is the single source of truth; an apps/api/.env is only
// honoured as a legacy override if someone still keeps one.
config({ path: path.join(REPO_ROOT, '.env') });
config({ path: path.resolve(__dirname, '../.env'), override: false });

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const WEBHOOK_PATH = '/api/v1/webhook';
const WEBHOOK_SECRET = process.env.META_WEBHOOK_SECRET;
const SEED_PHONE = process.env.SEED_BUSINESS_PHONE ?? '233244000001';

interface Args {
  text?: string;
  from: string;
  name?: string;
  image: boolean;
  phoneNumberId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { from: '233241000001', image: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--text':
        if (!next) throw new Error('--text requires a value');
        args.text = next;
        i++;
        break;
      case '--from':
        if (!next) throw new Error('--from requires a value');
        args.from = next.replace(/\D/g, '');
        i++;
        break;
      case '--name':
        if (!next) throw new Error('--name requires a value');
        args.name = next;
        i++;
        break;
      case '--phone-number-id':
        if (!next) throw new Error('--phone-number-id requires a value');
        args.phoneNumberId = next;
        i++;
        break;
      case '--image':
        args.image = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!args.image && !args.text) {
    throw new Error('Either --text or --image is required');
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/simulate-incoming.ts [flags]

Flags:
  --text <str>           The customer message (text payload)
  --image                Treats the payload as an image
  --from <phone>         Customer WA number (no +) — default 233241000001
  --name <name>          Optional profile name
  --phone-number-id <id> Override the seeded business phone-number-id
  --help, -h             Print this help
`);
}

/**
 * Works out which business the simulated message should be delivered to.
 *
 * Prefers an explicit override, then a business matching SEED_BUSINESS_PHONE,
 * and otherwise falls back to whichever business has a WhatsApp number
 * connected — so the script works straight after signing up in the UI, with no
 * seed step.
 */
async function resolvePhoneNumberId(override?: string): Promise<string> {
  if (override) return override;

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL missing — set it in the root .env');
  }

  const prisma = new PrismaClient();

  try {
    const seeded = await prisma.business.findFirst({
      where: { phone: SEED_PHONE, waPhoneNumberId: { not: null } },
      select: { name: true, waPhoneNumberId: true },
    });

    if (seeded?.waPhoneNumberId) return seeded.waPhoneNumberId;

    const anyConnected = await prisma.business.findFirst({
      where: { waPhoneNumberId: { not: null }, active: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { name: true, waPhoneNumberId: true },
    });

    if (anyConnected?.waPhoneNumberId) {
      console.log(`Delivering to "${anyConnected.name}"\n`);
      return anyConnected.waPhoneNumberId;
    }

    throw new Error(
      'No business has a WhatsApp number connected.\n' +
        'Register at http://localhost:5173 and connect a number in Settings,\n' +
        'or pass --phone-number-id explicitly.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

function buildPayload(args: Args, phoneNumberId: string): object {
  const waMessageId = `wamid.${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const message: Record<string, unknown> = {
    from: args.from,
    id: waMessageId,
    timestamp,
    type: args.image ? 'image' : 'text',
  };

  if (args.image) {
    message.image = {
      id: `media-${crypto.randomBytes(6).toString('hex')}`,
      mime_type: 'image/jpeg',
      sha256: crypto.randomBytes(32).toString('hex'),
      caption: args.text,
    };
  } else {
    message.text = { body: args.text };
  }

  const value: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: '233244000001',
      phone_number_id: phoneNumberId,
    },
    contacts: [],
    messages: [message],
  };

  if (args.name) {
    value.contacts = [
      { profile: { name: args.name }, wa_id: args.from },
    ];
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: `entry-${Date.now()}`,
        changes: [
          {
            field: 'messages',
            value,
          },
        ],
      },
    ],
  };
}

async function signAndSend(payload: object, secret: string): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const signatureHeader = `sha256=${sig}`;

  const res = await fetch(`${API_URL}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signatureHeader,
    },
    body: rawBody,
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  if (!WEBHOOK_SECRET) {
    throw new Error('META_WEBHOOK_SECRET missing — set it in the root .env');
  }

  const args = parseArgs(process.argv.slice(2));
  const phoneNumberId = await resolvePhoneNumberId(args.phoneNumberId);
  const payload = buildPayload(args, phoneNumberId);

  const { status, body } = await signAndSend(payload, WEBHOOK_SECRET);

  if (status === 200) {
    console.log(`✓ Delivered → ${API_URL}${WEBHOOK_PATH} (HTTP ${status})`);
    console.log(JSON.stringify(body, null, 2));
    console.log('\nWatch the API log for intent classification; the order will');
    console.log('appear in the dashboard within ~1 second if confidence ≥ 0.75.');
    process.exit(0);
  }

  console.error(`✗ Delivery failed (HTTP ${status}):`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(err.message);
  console.error(err.stack);
  process.exit(1);
});
