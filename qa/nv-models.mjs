/** Lists the models this NVIDIA key can call, so model choice is not guesswork. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
  headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}` },
});
const body = await res.json();
const ids = (body.data || []).map((m) => m.id).sort();
console.log(`status ${res.status} — ${ids.length} models`);

const interesting = ids.filter((id) =>
  /llama|nemotron|qwen|mistral|gemma|phi|command|granite|deepseek/i.test(id),
);
for (const id of interesting) console.log(id);
