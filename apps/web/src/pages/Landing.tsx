import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Menu, X } from 'lucide-react';
import Reveal from '@/components/ui/Reveal';
import CaptureDemo from '@/components/marketing/CaptureDemo';
import PricingTable from '@/components/marketing/PricingTable';
import Logo from '@/components/shared/Logo';
import { Button } from '@/components/ui/Button';
import { PLANS, TRIAL_DAYS, TRIAL_GRACE_HOURS } from '@/config/plans';
import { cn } from '@/lib/utils';

/**
 * The public page.
 *
 * Two rules govern the copy: say the thing, then stop. No sentence explains
 * what the previous sentence already said, and no section restates the hero.
 * The old version ran roughly 620 words before the pricing table; this one is
 * under 300, and reads as more confident for it.
 *
 * Structurally it follows the operations-landing pattern, product first,
 * proof second, mechanism third, price fourth, with one inverted band to
 * give the page a spine.
 *
 * A third rule, added after a pre-launch audit found four claims the product
 * does not honour: every sentence on this page has to be checkable against the
 * API. Not "defensible", checkable, by opening the file that implements it.
 * The claims that failed that test are noted where they were replaced, because
 * a copy change with no reason attached is a copy change someone reverts.
 */

const NAV_LINKS = [
  { label: 'How it works', href: '#how' },
  { label: 'Features', href: '#features' },
  { label: 'Pricing', href: '#pricing' },
];

function Nav(): React.JSX.Element {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-header border-b transition-colors duration-base ease-out',
        scrolled ? 'border-border bg-background/90 backdrop-blur-md' : 'border-transparent',
      )}
    >
      <div className="mx-auto flex h-16 max-w-shell items-center justify-between gap-6 px-5 lg:px-8">
        <Link
          to="/"
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Logo />
          <span className="sr-only">Flowdesk home</span>
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-sm text-sm font-medium text-text-secondary transition-colors duration-fast ease-out hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-1 md:flex">
          <Button variant="ghost" size="sm" onClick={() => navigate('/login')}>
            Log in
          </Button>
          <Button size="sm" onClick={() => navigate('/register')}>
            Start free
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md text-text-primary transition-colors duration-fast ease-out hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
        >
          {open ? <X className="h-5 w-5" strokeWidth={2} /> : <Menu className="h-5 w-5" strokeWidth={2} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-background px-5 pb-6 pt-1 md:hidden">
          <nav aria-label="Sections" className="flex flex-col">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="border-b border-border-subtle py-4 text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="mt-5 flex flex-col gap-2">
            <Button fullWidth onClick={() => navigate('/register')}>
              Start free
            </Button>
            <Button fullWidth variant="secondary" onClick={() => navigate('/login')}>
              Log in
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}

function Hero(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <section className="fd-aurora relative overflow-hidden border-b border-border pt-28 lg:pt-36">
      {/* Two layers, and they do different jobs. The aurora on the section
          itself is colour, three wide washes that give the top of the page
          somewhere to start. The ruling over it is structure. Colour alone
          reads as a template gradient; structure alone reads as a spreadsheet. */}
      <div
        aria-hidden="true"
        className="fd-ruled pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(130%_75%_at_50%_0%,#000_15%,transparent_72%)]"
      />

      <div className="relative mx-auto max-w-shell px-5 lg:px-8">
        <div className="grid items-center gap-12 pb-16 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1fr)] lg:gap-16 lg:pb-20">
          <Reveal>
            <h1 className="text-display-lg font-extrabold leading-[0.95] tracking-tighter">
              Every order, out of
              <br className="hidden sm:block" />{' '}
              <span className="relative inline-block">
                {/*
                  A highlighter stroke, in CSS, sitting across the baseline so
                  the descenders cut through it, which is what stops it
                  reading as a border under the words.

                  Two things went wrong getting here, both worth keeping
                  written down. `-z-10` on a child of a section that paints its
                  own background sends the stroke behind THAT, not behind the
                  text, so it vanished completely. And `bg-primary/12` compiled
                  to nothing at all, because a Tailwind alpha modifier needs
                  RGB channels and the token held a hex, see the alpha
                  channels in globals.css, which that bug is the reason for.

                  It is a solid tint rather than a transparency now: the brand
                  blue at 14% over white is indistinguishable from grey, and a
                  grey bar under a heading reads as a rendering fault.
                */}
                <span
                  aria-hidden="true"
                  className="absolute inset-x-[-0.06em] bottom-[0.18em] h-[0.3em] rounded-[0.06em] bg-primary-light"
                />
                <span className="relative">your chats.</span>
              </span>
            </h1>

            {/* "…and matches the payment" was the old third clause. Nothing in
                the product matches a payment: there is no telco or bank feed,
                and every payment is recorded and confirmed by a person. What
                Flowdesk actually does with a payment is refuse to let it stay
                buried in a chat thread. */}
            <p className="mt-6 max-w-prose text-md leading-relaxed text-text-secondary sm:text-lg">
              Flowdesk reads your WhatsApp, builds the order, and puts the payment in front of
              you to confirm.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
              <Button
                size="lg"
                onClick={() => navigate('/register')}
                trailingIcon={<ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
                className="w-full sm:w-auto"
              >
                Start free
              </Button>
              <span className="text-sm text-text-muted">
                {TRIAL_DAYS} days. No card.
              </span>
            </div>
          </Reveal>

          <Reveal delay={70}>
            {/* Seated in a tray rather than sitting flat on the page. This is
                the one element on the site the eye is meant to treat as a
                physical object, it is a picture of the product. */}
            <div className="fd-bezel">
              <CaptureDemo />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/**
 * The inverted band.
 *
 * One dark section, full-bleed, carrying four facts about the offer. It is
 * what stops a long light page reading as flat, and every figure in it is
 * checkable, rather than the invented traction numbers ("10,000+ businesses")
 * that this kind of band usually carries.
 *
 * Two of the four used to fail their own test. "Every feature" was untrue: the
 * trial runs on a real plan with real ceilings, so the honest version of that
 * line is about the card, not the feature set. And "2 minutes to connect your
 * number" was a number nobody had measured, replaced with the one thing about
 * the assistant a shop owner most needs to believe, which the grounding
 * validator and `resolveOrderItems` both enforce: a price the customer is
 * quoted comes out of the catalogue, and out of nothing else.
 */
const FACTS = [
  { figure: String(TRIAL_DAYS), unit: 'days free', note: 'No card to start.' },
  { figure: '0', unit: 'apps to install', note: 'Customers keep WhatsApp.' },
  {
    figure: PLANS.STARTER.price.replace('GHS ', ''),
    unit: 'cedis after',
    note: 'Starter, per month.',
  },
  { figure: '1', unit: 'source for prices', note: 'Your catalogue. Nowhere else.' },
];

function Facts(): React.JSX.Element {
  return (
    <section className="fd-ink relative overflow-hidden">
      <div
        aria-hidden="true"
        className="fd-ruled-ink pointer-events-none absolute inset-0 opacity-80 [mask-image:radial-gradient(120%_100%_at_50%_0%,#000,transparent_78%)]"
      />

      <h2 className="sr-only">Flowdesk in four figures</h2>

      <div className="relative mx-auto grid max-w-shell grid-cols-2 gap-x-6 gap-y-10 px-5 py-16 md:grid-cols-4 lg:gap-x-10 lg:px-8 lg:py-20">
        {FACTS.map((f, i) => (
          <Reveal key={f.unit} delay={i * 45}>
            <p className="fd-figure text-4xl font-extrabold leading-none tracking-tighter text-white lg:text-5xl">
              {f.figure}
            </p>
            <p className="mt-2.5 text-sm font-semibold text-text-on-ink">{f.unit}</p>
            <p className="mt-0.5 text-xs text-text-on-ink-muted">{f.note}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

const STEPS = [
  {
    n: '01',
    title: 'Connect your number',
    body: 'The one you already give customers, through Meta’s own setup in Settings.',
  },
  {
    n: '02',
    title: 'Messages become orders',
    body: 'Items and quantities from the message, prices from your catalogue. Anything ambiguous gets a question back rather than a guess.',
  },
  {
    n: '03',
    title: 'Confirm and assign',
    body: 'Drag it along the board and hand it to a rider. Stock comes off the count when you confirm, not before.',
  },
  {
    n: '04',
    title: 'Payment closes it',
    body: 'Record the momo and confirm it landed. The balance moves and the customer gets the receipt.',
  },
];

function HowItWorks(): React.JSX.Element {
  return (
    <section id="how" className="border-b border-border py-20 lg:py-32">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,0.38fr)_minmax(0,1fr)] lg:gap-16">
          <Reveal>
            <h2 className="text-display-sm font-extrabold tracking-tighter lg:sticky lg:top-28">
              Four steps.
            </h2>
          </Reveal>

          <div className="divide-y divide-border">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 45} className="py-6 first:pt-0 last:pb-0">
                <div className="grid gap-3 sm:grid-cols-[56px_minmax(0,1fr)] sm:gap-6">
                  <span className="fd-figure inline-flex h-9 w-9 items-center justify-center rounded-lg border border-primary-border bg-primary-light text-xs font-bold text-primary">
                    {s.n}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold tracking-tight">{s.title}</h3>
                    <p className="mt-1 max-w-prose text-base text-text-secondary">{s.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Six things, each one a screen in the product.
 *
 * "Every chat, searchable" and "Matched payments" are both gone. Search on the
 * Messages page filters the page of results already loaded, there is no search
 * parameter on the messages endpoint at all, and no payment is matched to
 * anything. What survives is what the screens actually do.
 */
const FEATURES = [
  { title: 'One inbox', body: 'Every message kept, and the ones needing you marked.' },
  { title: 'Order board', body: 'Pending to delivered, by drag.' },
  { title: 'Payments you confirm', body: 'Momo, transfer and cash, recorded against the order.' },
  { title: 'Customer balances', body: 'What they bought. What they still owe.' },
  { title: 'Stock that moves itself', body: 'Confirmed orders come off the count. Low stock is flagged.' },
  { title: 'Staff limits', body: 'Riders see the orders given to them. You see the money.' },
];

function Features(): React.JSX.Element {
  return (
    <section id="features" className="border-b border-border bg-surface py-20 lg:py-32">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Reveal>
          <h2 className="text-display-sm font-extrabold tracking-tighter">What you get.</h2>
        </Reveal>

        {/* Cards rather than grid cells with rules between them.
            The ruled version was honest and completely flat, six equal
            rectangles reading as a table of contents. These lift a hair on
            hover, which is the smallest possible way of saying each one is a
            screen you can actually go and look at. */}
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 55}>
              <div className="h-full rounded-xl bg-surface p-5 shadow-sm ring-1 ring-border-subtle transition-[transform,box-shadow] duration-200 ease-out [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-1 [@media(hover:hover)_and_(pointer:fine)]:hover:shadow-md">
                <span className="fd-figure text-2xs font-bold text-primary/70">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-2 text-lg font-bold tracking-tight">{f.title}</h3>
                <p className="mt-1.5 text-base text-text-secondary">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <section id="pricing" className="border-b border-border py-20 lg:py-32">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Reveal>
          <h2 className="text-display-sm font-extrabold tracking-tighter">Pricing.</h2>
          {/* "Everything unlocked" was not true, a trial runs on a real plan
              with that plan's ceilings, and "cancel from Settings" described a
              button the billing screen does not have. */}
          <p className="mt-3 max-w-prose text-base text-text-secondary">
            The {TRIAL_DAYS} days are free and need no card. Every plan runs the whole product;
            what changes is how much you send and how many people you let in.
          </p>
        </Reveal>

        <Reveal delay={50} className="mt-10">
          <PricingTable onChoose={() => navigate('/register')} />
        </Reveal>
      </div>
    </section>
  );
}

/**
 * The four hardest questions, plus the two the old version dodged.
 *
 * "It flags it instead of guessing. Nothing reaches a customer without you"
 * was false in every configuration, order confirmations, status answers,
 * clarifying questions and the standing templates all go out unattended, which
 * is the product working as designed and as the rest of this page describes.
 * Pretending otherwise sold a different, worse product to anyone who read
 * carefully, so the real safety story is spelled out instead: grounded in the
 * shop's own rows, priced from the database, drafted when it cannot be checked,
 * escalated when the question is about money or judgement.
 */
const QUESTIONS = [
  {
    q: 'Do I need a new number?',
    a: 'No. You connect the WhatsApp Business number you already publish, through Meta’s own setup flow in Settings.',
  },
  {
    q: 'Can it see my personal chats?',
    a: 'No. Only the business number you connect.',
  },
  {
    q: 'Does it reply to customers by itself?',
    a: 'Yes, that is the job. Order confirmations with the reference number, answers to “where is my order”, your own standing replies and any question it needs to ask before it can build an order all go out on their own. Replies the assistant writes in its own words stay off until you turn them on.',
  },
  {
    q: 'What if it reads an order wrong?',
    a: 'It answers out of your records or not at all. Prices come from the catalogue row and nowhere else, and any reply carrying a figure that does not match your own data is held back as a draft for you. Where the message is ambiguous it asks the customer rather than choosing for them, and bargaining, complaints and policy questions go straight to you.',
  },
  {
    q: 'Can I still reply from my own phone?',
    a: 'Yes. What you send from the WhatsApp Business app is recorded here too, and while you are answering a customer yourself the assistant stays out of that conversation.',
  },
  {
    q: 'What happens after the trial?',
    a: `Writes stop ${TRIAL_GRACE_HOURS} hours after it ends. You can still sign in, read every order, customer and message, and pay for a plan. Nothing is deleted.`,
  },
];

function Questions(): React.JSX.Element {
  return (
    <section className="border-b border-border bg-surface py-20 lg:py-32">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Reveal>
          <h2 className="text-display-sm font-extrabold tracking-tighter">Questions.</h2>
        </Reveal>

        <dl className="mt-10 grid gap-x-16 gap-y-7 border-t border-border pt-8 md:grid-cols-2">
          {QUESTIONS.map((item, i) => (
            <Reveal key={item.q} delay={(i % 2) * 40}>
              <dt className="text-base font-bold tracking-tight">{item.q}</dt>
              <dd className="mt-1 max-w-prose text-base text-text-secondary">{item.a}</dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}

function CallToAction(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <section className="border-b border-border py-20 lg:py-32">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Reveal className="flex flex-col items-start gap-7 lg:flex-row lg:items-end lg:justify-between">
          <h2 className="max-w-xl text-display-sm font-extrabold tracking-tighter">
            Stop losing orders in your chat history.
          </h2>

          <Button
            size="lg"
            onClick={() => navigate('/register')}
            trailingIcon={<ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
            className="w-full shrink-0 sm:w-auto"
          >
            Start free
          </Button>
        </Reveal>
      </div>
    </section>
  );
}

/** Written once: three links that must focus identically. */
const FOOTER_LINK =
  'rounded-sm text-sm text-text-secondary transition-colors duration-fast ease-out hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';

function Footer(): React.JSX.Element {
  return (
    <footer className="py-10">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          {/* Unlike the header marks, this one has no hidden label beside it. */}
          <Logo title="Flowdesk" />

          <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-2">
            <a href="mailto:hello@flowdesk.gh" className={FOOTER_LINK}>
              Contact
            </a>
            <Link to="/privacy" className={FOOTER_LINK}>
              Privacy
            </Link>
            <Link to="/terms" className={FOOTER_LINK}>
              Terms
            </Link>
          </nav>
        </div>

        <p className="mt-8 border-t border-border pt-5 text-xs text-text-muted">
          &copy; {new Date().getFullYear()} Flowdesk, Accra. WhatsApp is a trademark of Meta
          Platforms, Inc. Flowdesk is not affiliated with Meta.
        </p>
      </div>
    </footer>
  );
}

export default function LandingPage(): React.JSX.Element {
  return (
    <div className="min-h-[100dvh] bg-background">
      <a href="#content" className="fd-skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="content">
        <Hero />
        <Facts />
        <HowItWorks />
        <Features />
        <Pricing />
        <Questions />
        <CallToAction />
      </main>

      <Footer />
    </div>
  );
}
