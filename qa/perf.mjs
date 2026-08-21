import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4174';

async function run(label, { latency, down, cpu }) {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('flowdesk.session','1'); } catch {} });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.enable');
  if (latency) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency, downloadThroughput: down, uploadThroughput: down / 2,
    });
  }
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });

  const t0 = Date.now();
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const dcl = Date.now() - t0;
  await p.waitForFunction(() => /money in today/i.test(document.body.innerText), null, { timeout: 180_000 }).catch(() => {});
  const usable = Date.now() - t0;

  const nav = await p.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, Math.round(e.startTime)]));
    const res = performance.getEntriesByType('resource')
      .map(r => ({ n: r.name.split('/').pop().slice(0, 34), d: Math.round(r.duration), size: r.transferSize }))
      .sort((a, b) => b.d - a.d).slice(0, 6);
    return { ttfb: Math.round(n?.responseStart ?? 0), domContentLoaded: Math.round(n?.domContentLoadedEventEnd ?? 0), paints, slowest: res };
  });

  console.log(`\n── ${label}`);
  console.log(`   dom-content-loaded ${dcl}ms | usable ${usable}ms | ttfb ${nav.ttfb}ms | FCP ${nav.paints['first-contentful-paint'] ?? '?'}ms`);
  console.log('   slowest resources:');
  for (const r of nav.slowest) console.log(`     ${String(r.d).padStart(6)}ms  ${(r.size/1024).toFixed(0).padStart(5)}KB  ${r.n}`);
  await b.close();
  return usable;
}

await run('no throttling', { latency: 0, down: 0, cpu: 1 });
await run('Regular 3G (400ms RTT, 400kbps) + 4x CPU', { latency: 400, down: (400*1024)/8, cpu: 4 });
await run('Fast 3G (300ms RTT, 1.6Mbps) + 4x CPU', { latency: 300, down: (1.6*1024*1024)/8, cpu: 4 });
