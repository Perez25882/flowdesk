/**
 * Which model, and which structured-output mechanism, actually returns a
 * decision this server can use.
 *
 * The baseline eval showed 10 of 22 messages coming back malformed — the model
 * echoing the JSON schema instead of an instance of it — and every one of those
 * falls through to the canned template the customer then receives. That is a
 * mechanism failure, not a taste failure, so it gets measured rather than
 * guessed at.
 *
 *   pnpm --filter @flowdesk/api exec tsx scripts/probe-models.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { ASSISTANT_DECISION_JSON_SCHEMA, parseDecision } from '../src/services/assistant/decision.js';
import { ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from '../src/services/assistant/prompt.js';
import type { EvidenceProduct } from '../src/services/assistant/evidence.js';

// tsx does not load the root .env on its own, and this script deliberately
// does not import the app's env module — that would validate every unrelated
// variable just to read one key.
config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.env') });

const KEY = process.env.NVIDIA_API_KEY;
if (!KEY) {
  console.error('NVIDIA_API_KEY missing from the root .env');
  process.exit(1);
}
const URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const MODELS = [
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
];

/** The messages the baseline could not handle, plus one it could. */
const MESSAGES = [
  'Good morning',
  'I want 2 bags of rice 50kg',
  'wetin you get?',
  'How much be rice 50kg?',
];

const PRODUCTS: EvidenceProduct[] = [
  { id: 'p_rice50', name: 'Rice 50kg', unit: 'bag', price: 620, stockQuantity: 14 },
  { id: 'p_rice25', name: 'Rice 25kg', unit: 'bag', price: 330, stockQuantity: 6 },
  { id: 'p_malta', name: 'Malta Guinness 33cl', unit: 'crate', price: 132, stockQuantity: 22 },
];

function userPrompt(message: string): string {
  return buildUserPrompt({
    businessName: "Ama's Provisions",
    businessType: 'PROVISIONS_SHOP',
    businessTypeOther: null,
    profile: null,
    policyNotes: null,
    products: PRODUCTS,
    catalogueMode: 'CATALOGUE',
    openOrders: [],
    history: [],
    awaitingClarification: null,
    message,
  });
}

/** The schema, described in prose, as the provider currently does it. */
function schemaText(): string {
  return `Reply with a single JSON object matching this schema exactly. Output the object itself, not the schema.\n${JSON.stringify(ASSISTANT_DECISION_JSON_SCHEMA)}`;
}

/** One filled-in example. Models copy an instance far more reliably than a schema. */
const EXAMPLE = {
  intent: 'INQUIRY',
  confidence: 0.9,
  language: 'en',
  sentiment: 'neutral',
  entities: { products: [], amounts: [], phones: [], references: [] },
  answer: {
    canAnswer: true,
    text: 'Yes, we have it — GHS 620 a bag.',
    groundedOn: [{ kind: 'product', id: 'p_rice50', field: 'price' }],
  },
  clarification: { needed: false, missing: [] },
  order: { isOrder: false, complete: false, lines: [] },
  escalate: { needed: false, reason: null },
};

type Variant = 'guided_json' | 'json_schema' | 'example';

function buildBody(model: string, message: string, variant: Variant): Record<string, unknown> {
  const system =
    variant === 'example'
      ? `${ASSISTANT_SYSTEM_PROMPT}\n\nReply with ONE JSON object shaped exactly like this example. Replace the values; keep every key.\n${JSON.stringify(EXAMPLE, null, 2)}`
      : `${ASSISTANT_SYSTEM_PROMPT}\n\n${schemaText()}`;

  const body: Record<string, unknown> = {
    model,
    max_tokens: 2048,
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt(message) },
    ],
  };

  if (variant === 'guided_json') {
    body.response_format = { type: 'json_object' };
    body.nvext = { guided_json: ASSISTANT_DECISION_JSON_SCHEMA };
  } else if (variant === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'assistant_decision', strict: true, schema: ASSISTANT_DECISION_JSON_SCHEMA },
    };
  } else {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

async function once(model: string, message: string, variant: Variant) {
  const started = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(buildBody(model, message, variant)),
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ms, status: `HTTP ${res.status}`, reply: body.slice(0, 90) };
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      const m = /\{[\s\S]*\}/.exec(text);
      if (m) {
        try {
          raw = JSON.parse(m[0]);
        } catch {
          raw = null;
        }
      }
    }
    const decision = raw === null ? null : parseDecision(raw);
    return {
      ms,
      status: decision ? 'ok' : 'MALFORMED',
      reply: decision
        ? (decision.answer.text ?? '(no text)')
        : text.slice(0, 90).replace(/\s+/g, ' '),
    };
  } catch (error) {
    return { ms: Date.now() - started, status: 'THREW', reply: String(error).slice(0, 90) };
  }
}

async function main(): Promise<void> {
  const variants: Variant[] = ['guided_json', 'json_schema', 'example'];

  for (const model of MODELS) {
    console.log(`\n${'='.repeat(78)}\n${model}\n${'='.repeat(78)}`);
    for (const variant of variants) {
      let ok = 0;
      let total = 0;
      const times: number[] = [];
      for (const message of MESSAGES) {
        const r = await once(model, message, variant);
        total += 1;
        if (r.status === 'ok') ok += 1;
        times.push(r.ms);
        console.log(`  ${variant.padEnd(12)} ${String(r.ms).padStart(6)}ms  ${r.status.padEnd(16)} "${message}"`);
        console.log(`               → ${r.reply}`);
      }
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      console.log(`  ${variant.padEnd(12)} SCORE ${ok}/${total} valid, avg ${avg}ms\n`);
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
