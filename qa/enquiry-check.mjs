import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type()==='error' && !/TUNNEL|fonts\.googleapis/.test(m.text())) errs.push(m.text().slice(0,120)); });

await p.goto('http://127.0.0.1:4174/settings?tab=assistant', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
const text = await p.evaluate(() => document.body.innerText);
console.log('has catalogue question :', /Do you keep a product list here\?/i.test(text));
console.log('shows enquiry-led note :', /let me check on baggy jeans/i.test(text));
const sel = await p.evaluate(() => {
  const el = document.querySelector('#catalogue-mode');
  return el ? { value: el.value, options: [...el.options].map(o => o.value) } : null;
});
console.log('select                 :', JSON.stringify(sel));
await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/enquiry-settings.png', fullPage: false });

// Manual order with no catalogue: the picker must not be the only way in.
await p.goto('http://127.0.0.1:4174/orders', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
const newOrder = p.getByRole('button', { name: /new order/i }).first();
if (await newOrder.count()) {
  await newOrder.click();
  await p.waitForTimeout(1200);
  const t = await p.evaluate(() => document.body.innerText);
  console.log('manual order opens     :', /items/i.test(t));
  console.log('offers "Type it out"   :', /type it out/i.test(t));
  await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/enquiry-manual-order.png', fullPage: false });
}
console.log('console errors         :', errs.length ? errs.slice(0,3) : 'none');
await b.close();
