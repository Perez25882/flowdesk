/**
 * Drives the real web app the way an owner would, and records what it looks like.
 *
 * Two viewports because the persona is on a mid-range Android in Accra and the
 * owner is on a laptop in the shop — the same screen has to work for both, and
 * the desktop-only pass is the one that hides mobile regressions.
 *
 * Console errors and failed requests are collected per page. A screenshot that
 * looks fine while the console is full of 500s is not a passing test.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const OUT = '/home/claude/flowdesk/qa/shots';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, isMobile: true },
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
];

const PAGES = [
  { slug: 'landing', path: '/', auth: false },
  { slug: 'login', path: '/login', auth: false },
  { slug: 'register', path: '/register', auth: false },
  { slug: 'privacy', path: '/privacy', auth: false },
  { slug: 'terms', path: '/terms', auth: false },
  { slug: 'notfound', path: '/no-such-page', auth: false },
  { slug: 'dashboard', path: '/dashboard', auth: true },
  { slug: 'orders', path: '/orders', auth: true },
  { slug: 'customers', path: '/customers', auth: true },
  { slug: 'products', path: '/products', auth: true },
  { slug: 'payments', path: '/payments', auth: true },
  { slug: 'messages', path: '/messages', auth: true },
  { slug: 'staff', path: '/staff', auth: true },
  { slug: 'settings', path: '/settings', auth: true },
];

const findings = [];

function record(kind, viewport, slug, detail) {
  findings.push({ kind, viewport, slug, detail });
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
      userAgent: viewport.isMobile
        ? 'Mozilla/5.0 (Linux; Android 12; SM-A325F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
        : undefined,
    });

    // The app keeps the access token in memory and a non-credential hint in
    // localStorage; seeding the hint is what makes it attempt a refresh, which
    // the mock answers, so protected routes render as a signed-in owner.
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('flowdesk.session', '1');
      } catch { /* private mode */ }
    });

    for (const target of PAGES) {
      const page = await context.newPage();
      const consoleErrors = [];
      const failedRequests = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
      });
      page.on('requestfailed', (req) => {
        failedRequests.push(`${req.method()} ${req.url().slice(0, 120)}`);
      });
      page.on('response', (res) => {
        if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.url().slice(0, 120)}`);
      });

      try {
        // Not `networkidle`: the dashboard opens a Server-Sent Events stream and
        // holds it open for as long as the page lives, so the network never goes
        // idle and every authenticated page sat here until it timed out.
        await page.goto(`${BASE}${target.path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
        // Let React render and the first data fetches settle.
        await page.waitForTimeout(1800);
      } catch (error) {
        record('nav', viewport.name, target.slug, String(error).slice(0, 160));
      }

      // Scroll the whole page before capturing. The marketing page reveals
      // sections on scroll, so a screenshot taken without scrolling records
      // blank columns that a real visitor never sees.
      await page.evaluate(async () => {
        const step = window.innerHeight * 0.8;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 300));
      });

      // Freeze animation before capturing. Elements carrying a CSS transition
      // get their own compositing layer, and Chromium's full-page capture
      // stitches those layers as it scrolls — which smears or drops them. The
      // page is correct in the browser; only the screenshot was wrong.
      await page.addStyleTag({
        content: `*, *::before, *::after {
          transition: none !important;
          animation: none !important;
          scroll-behavior: auto !important;
        }`,
      });

      await page.waitForTimeout(700);

      // Horizontal overflow: the single most common mobile defect, and invisible
      // in a screenshot because the page just looks cropped.
      const overflow = await page.evaluate(() => {
        const d = document.documentElement;
        return { scrollW: d.scrollWidth, clientW: d.clientWidth };
      });
      if (overflow.scrollW > overflow.clientW + 1) {
        record('overflow', viewport.name, target.slug, `scrollWidth ${overflow.scrollW} > viewport ${overflow.clientW}`);
      }

      // Anything still saying it is not finished.
      const unfinished = await page.evaluate(() => {
        const text = document.body.innerText;
        const hits = [];
        // Case-sensitive with word boundaries: a case-insensitive "NaN" matches
        // the middle of "maintenance", and "undefined" needs to be the rendered
        // value rather than a word in a sentence.
        for (const needle of ['lorem ipsum', 'coming soon', 'not implemented', 'has not been published']) {
          if (text.toLowerCase().includes(needle)) hits.push(needle);
        }
        for (const needle of ['NaN', '[object Object]', 'undefined', 'TODO']) {
          if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) hits.push(needle);
        }
        return hits;
      });
      for (const hit of unfinished) record('placeholder-text', viewport.name, target.slug, hit);

      // A page that renders almost nothing is usually a silent failure, not a
      // deliberately sparse screen.
      const visibleChars = await page.evaluate(() => document.body.innerText.trim().length);
      if (visibleChars < 120) {
        record('empty-page', viewport.name, target.slug, `only ${visibleChars} characters of text rendered`);
      }

      // Images without alt text, and buttons with no accessible name.
      const a11y = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter((i) => !i.alt && i.getAttribute('role') !== 'presentation').length;
        const buttons = [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length;
        const h1 = document.querySelectorAll('h1').length;
        return { imgs, buttons, h1 };
      });
      if (a11y.imgs > 0) record('a11y', viewport.name, target.slug, `${a11y.imgs} image(s) with no alt text`);
      if (a11y.buttons > 0) record('a11y', viewport.name, target.slug, `${a11y.buttons} button(s) with no accessible name`);
      if (a11y.h1 !== 1) record('a11y', viewport.name, target.slug, `${a11y.h1} <h1> on the page (expected exactly 1)`);

      for (const error of consoleErrors) record('console', viewport.name, target.slug, error);
      for (const req of failedRequests) record('request', viewport.name, target.slug, req);

      await page.screenshot({ path: `${OUT}/${viewport.name}-${target.slug}.png`, fullPage: true });
      await page.close();
    }

    await context.close();
  }

  await browser.close();

  writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));

  const byKind = findings.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log('screenshots:', PAGES.length * VIEWPORTS.length);
  console.log('findings by kind:', JSON.stringify(byKind));
  for (const f of findings) console.log(`  [${f.kind}] ${f.viewport}/${f.slug}: ${f.detail}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
