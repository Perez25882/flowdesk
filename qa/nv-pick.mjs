/**
 * Picks a replacement assistant model after NVIDIA retired
 * `meta/llama-3.1-8b-instruct` (410 Gone, EOL 2026-08-26).
 *
 * Sends the SAME request shape the assistant uses in production
 * (`assistant-providers/nvidia.ts`): json_object response format, optional
 * nvext.guided_json, and a schema instruction in the system prompt. A model that
 * only looks good on a friendlier request shape is not a model we can ship.
 *
 * Scored on the two things that actually decide it:
 *   valid   — did it return JSON in the shape the router can consume
 *   latency — a reply the customer waits 40s for is not a reply
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

// Pass model ids as arguments to test just those, e.g.
//   node qa/nv-pick.mjs moonshotai/kimi-k3
// The NVIDIA /v1/models listing does not return every model the catalogue can
// serve, so a model missing from that list is not proof it cannot be called.
const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
  'nvidia/nemotron-nano-3-30b-a3b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-super-120b-a12b',
  'mistralai/mistral-nemotron',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'google/gemma-4-31b-it',
  'deepseek-ai/deepseek-v4-flash-0731',
  'nvidia/llama-3.1-nemotron-70b-instruct',
    ];

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['GREETING', 'INQUIRY', 'ORDER', 'OTHER'] },
    canAnswer: { type: 'boolean' },
    text: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['intent', 'canAnswer', 'text', 'confidence'],
};

// A real shop's evidence, so the answer has to be grounded rather than invented.
const SYSTEM = `You are the assistant for Manoip, a clothing shop in Kumasi, Ghana.
Reply the way the shop owner would: warm, brief, Ghanaian English or Pidgin where natural.

Stock you may cite, and nothing else:
- Baggy Jeans, GHS 120.00, 14 in stock
- Hoodie, GHS 150.00, 11 in stock
- Vintage Tee, GHS 60.00, 25 in stock
- Sneakers UK 9, GHS 250.00, 4 in stock

Never invent a product, a price or a stock level. If it is not listed, say you will check.

Answer ONLY with a JSON object matching this schema:
${JSON.stringify(SCHEMA)}`;

const PROMPTS = [
  'Do you have baggy jeans?',
  'How much be the hoodie?',
  'Good morning',
  'You get red Nike cap?',
];

async function callOnce(model, prompt, guided) {
  const body = {
    model,
    max_tokens: 512,
    temperature: 0.4,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  };
  if (guided) body.nvext = { guided_json: SCHEMA };

  const started = Date.now();
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(75_000),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      const detail = text.slice(0, 110).replace(/\s+/g, ' ');
      return { ms, ok: false, note: `HTTP ${res.status} ${detail}` };
    }
    const json = JSON.parse(text);
    const content = json.choices?.[0]?.message?.content ?? '';
    // Models often wrap JSON in prose or a fence; the production parser is
    // tolerant of that, so this one is too.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { ms, ok: false, note: `no JSON: ${content.slice(0, 70)}` };
    const parsed = JSON.parse(match[0]);
    const valid =
      typeof parsed.text === 'string' &&
      typeof parsed.canAnswer === 'boolean' &&
      typeof parsed.intent === 'string';
    return { ms, ok: valid, note: valid ? parsed.text.slice(0, 90) : 'shape mismatch' };
  } catch (err) {
    return { ms: Date.now() - started, ok: false, note: String(err).slice(0, 80) };
  }
}

for (const model of CANDIDATES) {
  console.log(`\n=== ${model}`);
  let valid = 0;
  let total = 0;
  for (const guided of [true, false]) {
    let modeValid = 0;
    const times = [];
    for (const prompt of PROMPTS) {
      const r = await callOnce(model, prompt, guided);
      times.push(r.ms);
      if (r.ok) modeValid += 1;
      console.log(
        `  ${guided ? 'guided' : 'plain '} ${String(r.ms).padStart(6)}ms ${r.ok ? 'ok  ' : 'BAD '} ${r.note}`,
      );
    }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    console.log(`  ${guided ? 'guided' : 'plain '} SCORE ${modeValid}/${PROMPTS.length}  avg ${avg}ms`);
    valid += modeValid;
    total += PROMPTS.length;
    if (guided && modeValid === PROMPTS.length && avg < 6000) {
      console.log('  (guided already good and fast — skipping plain)');
      break;
    }
  }
  console.log(`  TOTAL ${valid}/${total}`);
}
