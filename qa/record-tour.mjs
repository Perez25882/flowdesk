/**
 * A guided walk through Flowdesk, recorded.
 *
 * Playwright drives a real browser against the production build, so what is on
 * screen is the shipped bundle rather than a mock-up. A visible cursor is
 * injected because Playwright's video does not capture the pointer, and a
 * recording where things happen with nothing touching them is unreadable.
 *
 *   node qa/record-tour.mjs desktop
 *   node qa/record-tour.mjs mobile
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const DEVICE = process.argv[2] === 'mobile' ? 'mobile' : 'desktop';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4174';
const OUT = `/home/claude/out/video/raw-${DEVICE}`;
mkdirSync(OUT, { recursive: true });

const VIEWPORT =
  DEVICE === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };

/** Draws the pointer, because the recorder does not. */
const CURSOR_SCRIPT = () => {
  const install = () => {
    const dot = document.createElement('div');
    dot.setAttribute('data-tour-cursor', '');
    Object.assign(dot.style, {
      position: 'fixed',
      width: '20px',
      height: '20px',
      marginLeft: '-10px',
      marginTop: '-10px',
      borderRadius: '50%',
      border: '2px solid #3d6b52',
      background: 'rgba(61,107,82,0.25)',
      boxShadow: '0 0 0 4px rgba(61,107,82,0.10)',
      pointerEvents: 'none',
      zIndex: '2147483647',
      left: '-50px',
      top: '-50px',
      transition: 'transform 90ms ease-out',
    });
    document.documentElement.appendChild(dot);

    document.addEventListener(
      'mousemove',
      (e) => {
        dot.style.left = `${e.clientX}px`;
        dot.style.top = `${e.clientY}px`;
      },
      true,
    );

    document.addEventListener(
      'mousedown',
      () => {
        dot.style.transform = 'scale(0.6)';
        setTimeout(() => (dot.style.transform = 'scale(1)'), 160);
      },
      true,
    );
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: DEVICE === 'mobile',
    hasTouch: DEVICE === 'mobile',
    recordVideo: { dir: OUT, size: VIEWPORT },
  });

  // NOTE: the session hint is deliberately NOT seeded up front. With it set,
  // start-up exchanges it for a token, `IndexRoute` sees an authenticated
  // visitor and replaces `/` and `/login` with `/dashboard` — so the first
  // recording contained neither the landing page nor the sign-in form. The
  // tour signs in through the form instead, which is what a new visitor does.
  await context.addInitScript(CURSOR_SCRIPT);

  const page = await context.newPage();

  /** Moves the pointer there in visible steps, then clicks. */
  async function clickOn(locator, { settle = 900 } = {}) {
    const box = await locator.boundingBox();
    if (!box) return false;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
    await wait(320);
    await page.mouse.down();
    await wait(90);
    await page.mouse.up();
    await wait(settle);
    return true;
  }

  async function goto(path, settle = 1500) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await wait(settle);
  }

  /** Scrolls in small increments so the reveal animations actually play. */
  async function scrollThrough(steps = 8, pause = 520) {
    for (let i = 0; i < steps; i += 1) {
      await page.mouse.wheel(0, VIEWPORT.height * 0.72);
      await wait(pause);
    }
  }

  async function scrollTop() {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await wait(900);
  }

  // ── 1. The public page ────────────────────────────────────────────────
  await goto('/', 2200);
  await page.mouse.move(VIEWPORT.width * 0.5, VIEWPORT.height * 0.45, { steps: 18 });
  await wait(900);
  await scrollThrough(DEVICE === 'mobile' ? 12 : 8, 560);
  await wait(700);

  // ── 2. Signing in ─────────────────────────────────────────────────────
  await goto('/login', 1700);
  const email = page.locator('input[type=email], input[name=email]').first();
  if (await email.count()) {
    await clickOn(email, { settle: 250 });
    await email.type('abena@amasprovisions.gh', { delay: 55 });
    await wait(400);
    const pw = page.locator('input[type=password]').first();
    if (await pw.count()) {
      await clickOn(pw, { settle: 200 });
      await pw.type('correct-horse-battery', { delay: 45 });
      await wait(700);
    }
    const submit = page.getByRole('button', { name: /^Sign in$/i }).first();
    if (await submit.count()) {
      await clickOn(submit, { settle: 2600 });
    }
  }

  // If the form did not carry us through, fall back to the session hint so the
  // rest of the tour still records rather than sitting on a login screen.
  if (!page.url().includes('/dashboard')) {
    await page.evaluate(() => {
      try {
        window.localStorage.setItem('flowdesk.session', '1');
      } catch {
        /* private mode */
      }
    });
  }

  // ── 3. The morning dashboard ──────────────────────────────────────────
  await goto('/dashboard', 2400);
  await page.mouse.move(VIEWPORT.width * 0.3, VIEWPORT.height * 0.3, { steps: 16 });
  await wait(1400);
  await scrollThrough(DEVICE === 'mobile' ? 5 : 2, 800);
  await wait(900);
  await scrollTop();

  // ── 4. Orders, and what an owner does to one ──────────────────────────
  await goto('/orders', 2000);
  await wait(900);

  const card = page.getByRole('button', { name: /FD-000/ }).first();
  if (await card.count()) {
    await clickOn(card, { settle: 1800 });

    // The cancellation dialog: the reason is required because the customer is
    // told it.
    const cancel = page.getByRole('button', { name: /^Cancel$/ }).first();
    if (await cancel.count()) {
      await clickOn(cancel, { settle: 1200 });
      const reason = page.getByRole('textbox').last();
      if (await reason.count()) {
        await clickOn(reason, { settle: 200 });
        await reason.type('Out of stock until Thursday', { delay: 42 });
        await wait(1300);
      }
      const keep = page.getByRole('button', { name: /Keep the order/i }).first();
      if (await keep.count()) await clickOn(keep, { settle: 900 });
    }

    await page.keyboard.press('Escape');
    await wait(900);
  }

  // ── 5. Customers, and how the shop treats one ─────────────────────────
  await goto('/customers', 1700);
  await wait(800);
  const customer = page.locator('a[href*="/customers/"], [role=button]').filter({ hasText: /Emmanuel|Kwesi|Akosua/ }).first();
  if (await customer.count()) {
    await clickOn(customer, { settle: 2000 });
  } else {
    await goto('/customers/c1', 2000);
  }
  await scrollThrough(2, 700);
  await wait(1000);

  // ── 6. Catalogue, money, conversations ────────────────────────────────
  await goto('/products', 1900);
  await wait(1100);
  await goto('/payments', 1900);
  await wait(1300);
  await goto('/messages', 2000);
  await wait(1600);
  await scrollThrough(2, 700);

  // ── 7. Staff ──────────────────────────────────────────────────────────
  await goto('/staff', 1800);
  await wait(1300);

  // ── 8. Settings: the assistant, and shops that keep no product list ───
  await goto('/settings', 1900);
  const assistantTab = page.locator('text=Assistant').first();
  if (await assistantTab.count()) {
    await clickOn(assistantTab, { settle: 1500 });
  }
  await scrollThrough(DEVICE === 'mobile' ? 7 : 4, 620);

  const catalogueSelect = page.locator('#catalogue-mode');
  if (await catalogueSelect.count()) {
    await clickOn(catalogueSelect, { settle: 500 });
    await catalogueSelect.selectOption('ENQUIRY_LED');
    await wait(2200);
  }
  await wait(1200);

  await context.close();
  await browser.close();
  console.log(`recorded ${DEVICE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
