import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:4174/settings', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
console.log('URL:', p.url());
console.log('TABS:', await p.evaluate(() => [...document.querySelectorAll('button,[role=tab]')].map(e=>e.textContent.trim()).filter(t=>t&&t.length<30).slice(0,14)));
const tab = p.locator('text=Assistant').first();
console.log('assistant tab found:', await tab.count());
if (await tab.count()) { await tab.click(); await p.waitForTimeout(1500); }
const t = await p.evaluate(() => document.body.innerText);
console.log('TEXT:', t.slice(0,700).replace(/\n+/g,' | '));
await b.close();
