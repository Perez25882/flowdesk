import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await p.evaluate(async () => {
  const step = window.innerHeight * 0.8;
  for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); }
});
await p.waitForTimeout(1200);
const out = await p.evaluate(() => {
  return [...document.querySelectorAll('.fd-reveal')].map((el) => ({
    shown: el.getAttribute('data-shown'),
    opacity: getComputedStyle(el).opacity,
    top: Math.round(el.getBoundingClientRect().top + window.scrollY),
    h: Math.round(el.getBoundingClientRect().height),
    text: (el.textContent || '').trim().slice(0, 45),
  }));
});
console.log('reveal elements:', out.length);
for (const o of out) console.log(`  shown=${o.shown} op=${o.opacity} top=${o.top} h=${o.h} :: ${o.text}`);
const secs = await p.evaluate(() => [...document.querySelectorAll('section')].map(s => ({ top: Math.round(s.getBoundingClientRect().top + window.scrollY), h: Math.round(s.getBoundingClientRect().height), op: getComputedStyle(s).opacity, t: (s.textContent||'').trim().slice(0,40) })));
console.log('sections:'); for (const s of secs) console.log(`  top=${s.top} h=${s.h} op=${s.op} :: ${s.t}`);
await b.close();
