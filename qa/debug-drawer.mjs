import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
const p = await ctx.newPage();
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE ERR:', m.text().slice(0,160)); });
await p.goto('http://127.0.0.1:4174/orders', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
console.log('URL:', p.url());
console.log('text sample:', (await p.evaluate(()=>document.body.innerText)).slice(0,400).replace(/\n+/g,' | '));
const el = p.getByRole('button', { name: /FD-00042/ }).first();
console.log('found FD-00042:', await el.count());
if (await el.count()) {
  const box = await el.boundingBox();
  console.log('box:', JSON.stringify(box));
  await el.click();
  await p.waitForTimeout(2500);
  console.log('after click text:', (await p.evaluate(()=>document.body.innerText)).slice(0,500).replace(/\n+/g,' | '));
  const buttons = await p.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,25));
  console.log('buttons:', JSON.stringify(buttons));
}
await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/debug-orders.png', fullPage: false });
await b.close();
