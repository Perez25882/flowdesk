import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await p.evaluate(async () => {
  const step = window.innerHeight * 0.8;
  for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); }
  window.scrollTo(0, 0);
});
await p.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await p.waitForTimeout(500);
const h = await p.evaluate(() => document.documentElement.scrollHeight);
console.log('page height', h);
await p.setViewportSize({ width: 1440, height: Math.min(h, 20000) });
await p.waitForTimeout(800);
await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/landing-tall.png' });
console.log('done');
await b.close();
