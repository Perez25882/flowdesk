import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type()==='error' && !/TUNNEL|fonts\.googleapis/.test(m.text())) errs.push(m.text().slice(0,120)); });
p.on('dialog', d => d.accept());

// 1. Intent corrections must not offer values the API rejects.
await p.goto('http://127.0.0.1:4174/messages', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
const t = await p.evaluate(() => document.body.innerText);
console.log('no "A cancellation" option :', !/A cancellation/.test(t));
console.log('no "Thanks" option        :', !/\bThanks\b/.test(t));
console.log('offers "Asking about an order":', /Asking about an order/.test(t));

// 2. VIP / blocked controls.
await p.goto('http://127.0.0.1:4174/customers/c1', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
const boxes = await p.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].length);
const ct = await p.evaluate(() => document.body.innerText);
console.log('customer flag panel       :', /How we treat them/i.test(ct), `(${boxes} checkboxes)`);
console.log('explains blocking         :', /stops replying automatically/i.test(ct));
await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/customer-flags.png', fullPage: false });

// 3. Staff deactivation.
await p.goto('http://127.0.0.1:4174/staff', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
const disable = p.getByRole('button', { name: /^Disable$/ });
console.log('staff disable buttons     :', await disable.count());
if (await disable.count()) {
  await disable.first().click();
  await p.waitForTimeout(1200);
  console.log('disable click survived    :', true);
}
await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/staff-controls.png', fullPage: false });

console.log('console errors            :', errs.length ? errs.slice(0,3) : 'none');
await b.close();
