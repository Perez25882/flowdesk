/**
 * The owner's actual day, driven in a browser.
 *
 * Screenshots tell you a page rendered. These tell you the product works: that
 * a button does what it says, that a required field is enforced where the
 * server enforces it, and that the screen the owner opens first arrives inside
 * the budget the PRD sets for a Ghanaian 3G connection.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

// The production build, not the dev server: throttling an unbundled dev
// server measures Vite, not the product.
const BASE = process.env.BASE ?? 'http://127.0.0.1:4174';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function signedInPage(browser, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    try { window.localStorage.setItem('flowdesk.session', '1'); } catch { /* ignore */ }
  });
  return context;
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // ── Journey 1: cancelling an order ─────────────────────────────────────
  // Until this change there was no working way to cancel an order anywhere in
  // the product: the button sent no reason, the API required one, and the 400
  // was never rendered. This is the regression test for that.
  {
    const context = await signedInPage(browser);
    const page = await context.newPage();
    await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const card = page.locator('text=FD-00042').first();
    check('orders board shows a pending order', await card.count() > 0);

    await card.click();
    await page.waitForTimeout(2000);

    const drawerOpen = await page.getByText(/FD-00042/).count() > 0
      && await page.getByRole('button', { name: /confirm|mark|cancel/i }).count() > 0;
    check('clicking an order opens its detail drawer', drawerOpen);

    const cancelButton = page.getByRole('button', { name: /^Cancel$/ }).first();
    const hasCancel = await cancelButton.count() > 0;
    check('order drawer offers a cancel action', hasCancel);

    if (hasCancel) {
      await cancelButton.click();
      await page.waitForTimeout(700);

      const dialogVisible = await page.getByText(/Cancel FD-00042/i).count() > 0;
      check('cancelling opens a dialog rather than firing a doomed request', dialogVisible);

      // Empty reason must be refused in the client, because the server refuses it.
      const confirm = page.getByRole('button', { name: /Cancel the order/i }).first();
      await confirm.click();
      await page.waitForTimeout(600);
      const refused = await page.getByText(/give a reason/i).count() > 0;
      check('an empty reason is refused with an explanation', refused);

      await page.getByRole('textbox').last().fill('Out of stock until Thursday');
      await confirm.click();
      await page.waitForTimeout(1500);

      const dialogGone = await page.getByText(/Cancel FD-00042/i).count() === 0;
      check('cancelling with a reason succeeds and closes the dialog', dialogGone);

      await page.screenshot({ path: '/home/claude/flowdesk/qa/shots/journey-cancel.png', fullPage: false });
    }
    await context.close();
  }

  // ── Journey 2: the owner's first screen, on a throttled 3G connection ──
  // PRD 4.1: dashboard load under 4 seconds on 3G, cold.
  {
    const context = await signedInPage(browser, { width: 390, height: 844 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // Regular 3G, the figures Chrome DevTools itself uses.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 300,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    const started = Date.now();
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('text=Today', { timeout: 60_000 }).catch(() => {});
    const firstPaint = Date.now() - started;

    await page.waitForFunction(() => /money in today/i.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
    const usable = Date.now() - started;

    check('dashboard is readable within 4s on throttled 3G', usable <= 4000, `${usable}ms to a usable screen (${firstPaint}ms to first content)`);
    await page.screenshot({ path: '/home/claude/flowdesk/qa/shots/journey-3g-dashboard.png', fullPage: false });
    await context.close();
  }

  // ── Journey 3: keyboard reachability ──────────────────────────────────
  {
    const context = await signedInPage(browser);
    const page = await context.newPage();
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    let reachable = 0;
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return { tag: el.tagName, outline: style.outlineStyle, shadow: style.boxShadow !== 'none' };
      });
      if (focused) reachable += 1;
    }
    check('the dashboard is navigable by keyboard', reachable >= 8, `${reachable}/25 tab stops landed on a focusable element`);
    await context.close();
  }

  // ── Journey 4: the customer-facing surface a stranger sees first ───────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Counted as button OR link: the CTAs are currently <button onClick=navigate>,
    // which is itself a finding — a marketing CTA should be an anchor so it can
    // be opened in a new tab and followed by a crawler.
    const asLink = await page.getByRole('link', { name: /start free/i }).count();
    const asButton = await page.getByRole('button', { name: /start free/i }).count();
    check('landing page offers a signup route', asLink + asButton > 0, `${asLink} link(s), ${asButton} button(s)`);
    check('signup CTA is a real link, not a button', asLink > 0, asLink === 0 ? 'CTAs are <button onClick>, not crawlable or openable in a new tab' : '');

    const priceShown = await page.getByText(/GHS\s*150/i).count() > 0;
    check('landing page shows the real Starter price', priceShown);

    // The claims the audit found false must be gone.
    const text = await page.evaluate(() => document.body.innerText);
    check('no "nothing reaches a customer without you" claim', !/nothing reaches a customer without you/i.test(text));
    check('no "matches the payment" claim', !/matches the payment/i.test(text));
    check('no "every chat, searchable" claim', !/every chat, searchable/i.test(text));
    check('pricing table does not sell broadcasts', !/broadcast/i.test(text));

    await context.close();
  }

  await browser.close();

  writeFileSync('/home/claude/flowdesk/qa/journeys.json', JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
