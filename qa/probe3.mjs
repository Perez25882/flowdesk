import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await p.evaluate(async () => { const s=innerHeight*0.8; for(let y=0;y<document.body.scrollHeight;y+=s){scrollTo(0,y); await new Promise(r=>setTimeout(r,150));} });
const info = await p.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim().startsWith('Stop losing orders'));
  if (!el) return 'not found';
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const parent = el.closest('section');
  const ps = parent ? getComputedStyle(parent) : null;
  return { tag: el.tagName, color: cs.color, bg: cs.backgroundColor, op: cs.opacity, vis: cs.visibility,
           rect: { top: Math.round(r.top+scrollY), h: Math.round(r.height) },
           sectionBg: ps?.backgroundColor, sectionColor: ps?.color };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
