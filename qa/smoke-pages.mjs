import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4174';
const PAGES = ['/', '/login', '/privacy', '/terms', '/dashboard', '/orders', '/customers',
                '/products', '/payments', '/messages', '/staff', '/settings', '/no-such-page'];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let bad = 0;
for (const vp of [{ n: 'mobile', w: 390, h: 844 }, { n: 'desktop', w: 1440, h: 900 }]) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
  for (const path of PAGES) {
    const p = await ctx.newPage();
    const errs = [];
    p.on('console', m => { if (m.type()==='error' && !/TUNNEL|fonts\.googleapis/.test(m.text())) errs.push(m.text().slice(0,90)); });
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
    await p.waitForTimeout(1400);
    const r = await p.evaluate(() => ({
      chars: document.body.innerText.trim().length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      h1: document.querySelectorAll('h1').length,
      junk: /\bNaN\b|\[object Object\]|\bundefined\b/.test(document.body.innerText),
    }));
    const ok = r.chars > 120 && !r.overflow && !r.junk && errs.length === 0;
    if (!ok) { bad++; console.log(`FAIL ${vp.n}${path} chars=${r.chars} overflow=${r.overflow} h1=${r.h1} junk=${r.junk} errs=${errs.slice(0,2)}`); }
    await p.close();
  }
  await ctx.close();
}
console.log(bad === 0 ? `OK — ${PAGES.length * 2} page renders clean` : `${bad} problem(s)`);
await b.close();
