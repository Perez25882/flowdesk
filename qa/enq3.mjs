import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:4174/settings', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
await p.locator('text=Assistant').first().click();
await p.waitForTimeout(1500);
// Scroll the whole tab so lazy sections render.
await p.evaluate(async () => { const s=innerHeight*0.8; for(let y=0;y<document.body.scrollHeight;y+=s){scrollTo(0,y); await new Promise(r=>setTimeout(r,120));} });
await p.waitForTimeout(600);
const sel = await p.evaluate(() => {
  const el = document.querySelector('#catalogue-mode');
  return el ? { value: el.value, options: [...el.options].map(o => o.textContent.trim()) } : null;
});
console.log('catalogue-mode select :', JSON.stringify(sel));
const t = await p.evaluate(() => document.body.innerText);
console.log('has question          :', /Do you keep a product list here\?/i.test(t));
console.log('note shown (enq-led)  :', /let me check on baggy jeans/i.test(t));
if (sel) {
  await p.selectOption('#catalogue-mode', 'CATALOGUE');
  await p.waitForTimeout(500);
  const t2 = await p.evaluate(() => document.body.innerText);
  console.log('note hidden on CATALOGUE:', !/let me check on baggy jeans/i.test(t2));
}
await p.screenshot({ path: '/home/claude/flowdesk/qa/shots/enquiry-settings.png', fullPage: true });
await b.close();
