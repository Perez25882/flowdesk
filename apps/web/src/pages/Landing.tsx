import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Menu, X } from 'lucide-react';
import Reveal from '@/components/ui/Reveal';
import CaptureDemo from '@/components/marketing/CaptureDemo';
import PricingTable from '@/components/marketing/PricingTable';
import Logo from '@/components/shared/Logo';
import { Button } from '@/components/ui/Button';
import { PLANS } from '@/config/plans';
import { cn } from '@/lib/utils';

/**
 * The public page.
 *
 * Two rules govern the copy: say the thing, then stop. No sentence explains
 * what the previous sentence already said, and no section restates the hero.
 * The old version ran roughly 620 words before the pricing table; this one is
 * under 300, and reads as more confident for it.
 *
 * Structurally it follows the operations-landing pattern — product first,
 * proof second, mechanism third, price fourth — with one inverted band to
 * give the page a spine.
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
              className="text-sm font-medium text-text-secondary transition-colors duration-fast ease-out hover:text-text-primary"
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
                className="border-b border-border-subtle py-4 text-base font-medium"
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
    <section className="relative overflow-hidden border-b border-border pt-24 lg:pt-32">
      <div
        aria-hidden="true"
        className="fd-ruled pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(130%_75%_at_50%_0%,#000_15%,transparent_72%)]"
      />

      <div className="relative mx-auto max-w-shell px-5 lg:px-8">
        <div className="grid items-center gap-10 pb-14 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1fr)] lg:gap-14 lg:pb-20">
          <Reveal>
            <p className="fd-label">WhatsApp commerce, Ghana</p>

            <h1 className="mt-4 text-display-lg font-extrabold tracking-tighter">
              Every order, out of
              <br className="hidden sm:block" /> your chats.
            </h1>

            <p className="mt-5 max-w-prose text-md leading-relaxed text-text-secondary sm:text-lg">
              Flowdesk reads your WhatsApp, builds the order, and matches the payment.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <Button
                size="lg"
                onClick={() => navigate('/register')}
                trailingIcon={<ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
                className="w-full sm:w-auto"
              >
                Start free
              </Button>
              <span className="text-sm text-text-muted">
                14 days. No card.
              </span>
            </div>
          </Reveal>

          <Reveal delay={70}>
            <CaptureDemo />
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
 * what stops a long light page reading as flat — and every figure in it is
 * checkable, rather than the invented traction numbers ("10,000+ businesses")
 * that this kind of band usually carries.
 */
const FACTS = [
  { figure: '14', unit: 'days free', note: 'Every feature. No card.' },
  { figure: '2', unit: 'minutes', note: 'To connect your number.' },
  { figure: PLANS.STARTER.price.replace('GHS ', ''), unit: 'cedis after', note: 'Starter, per month.' },
  { figure: '0', unit: 'apps to install', note: 'Customers keep WhatsApp.' },
];

function Facts(): React.JSX.Element {
  return (
    <section className="fd-ink relative overflow-hidden">
      <div
        aria-hidden="true"
        className="fd-ruled-ink pointer-events-none absolute inset-0 opacity-80 [mask-image:radial-gradient(120%_100%_at_50%_0%,#000,transparent_78%)]"
      />

      <div className="relative mx-auto grid max-w-shell grid-cols-2 gap-x-6 gap-y-9 px-5 py-14 md:grid-cols-4 lg:gap-x-10 lg:px-8 lg:py-18">
        {FACTS.map((f, i) => (
          <Reveal key={f.unit} delay={i * 45}>
            <p className="fd-figure text-3xl font-extrabold tracking-tighter text-white">
              {f.figure}
            </p>
            <p className="mt-1 text-sm font-semibold text-text-on-ink">{f.unit}</p>
            <p className="mt-0.5 text-xs text-text-on-ink-muted">{f.note}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

const STEPS = [
  { n: '01', title: 'Connect your number', body: 'The one you already give customers.' },
  { n: '02', title: 'Messages become orders', body: 'Items, quantities, price. Anything unclear waits for you.' },
  { n: '03', title: 'Confirm and assign', body: 'Move it across the board as it is packed.' },
  { n: '04', title: 'Payment closes it', body: 'Log the momo. The balance updates. The receipt goes back.' },
];

function HowItWorks(): React.JSX.Element {
  return (
    <section id="how" className="border-b border-border py-16 lg:py-24">
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
                <div className="grid gap-2 sm:grid-cols-[48px_minmax(0,1fr)] sm:gap-6">
                  <span className="fd-figure text-sm font-bold text-primary">{s.n}</span>
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

const FEATURES = [
  { title: 'One inbox', body: 'Every chat, searchable.' },
  { title: 'Order board', body: 'Pending to delivered, by drag.' },
  { title: 'Matched payments', body: 'Momo, transfer and cash against the order.' },
  { title: 'Customer balances', body: 'What they bought. What they owe.' },
  { title: 'Stock warnings', body: 'Before you sell what you no longer have.' },
  { title: 'Staff limits', body: 'Riders see orders. You see money.' },
];

function Features(): React.JSX.Element {
  return (
    <section id="features" className="border-b border-border bg-surface py-16 lg:py-24">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Reveal>
          <h2 className="text-display-sm font-extrabold tracking-tighter">What you get.</h2>
        </Reveal>

        <div className="mt-10 grid border-t border-border sm:grid-cols-2">
          {FEATURES.map((f, i) => (
            <Reveal
              key={f.title}
              delay={(i % 2) * 40}
              className={cn('border-b border-border py-6 pr-6', i % 2 === 1 && 'sm:border-l sm:pl-8')}
            >
              <div className="flex items-baseline gap-3">
                <span className="fd-figure text-xs text-text-muted">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="text-lg font-bold tracking-tight">{f.title}</h3>
              </div>
              <p className="mt-1.5 pl-[30px] text-base text-text-secondary">{f.body}</p>
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
    <section id="pricing" className="border-b border-border py-16 lg:py-24">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Reveal>
          <h2 className="text-display-sm font-extrabold tracking-tighter">Pricing.</h2>
          <p className="mt-3 max-w-prose text-base text-text-secondary">
            Start on the trial with everything unlocked. Cancel from Settings.
          </p>
        </Reveal>

        <Reveal delay={50} className="mt-10">
          <PricingTable onChoose={() => navigate('/register')} />
        </Reveal>
      </div>
    </section>
  );
}

const QUESTIONS = [
  { q: 'Do I need a new number?', a: 'No. Flowdesk connects to the WhatsApp Business number you already publish.' },
  { q: 'Can it see my personal chats?', a: 'No. Only the business number you connect.' },
  { q: 'What if it reads an order wrong?', a: 'It flags it instead of guessing. Nothing reaches a customer without you.' },
  { q: 'What happens after the trial?', a: 'The account goes read-only. Nothing is deleted.' },
];

function Questions(): React.JSX.Element {
  return (
    <section className="border-b border-border bg-surface py-16 lg:py-24">
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
    <section className="border-b border-border py-16 lg:py-24">
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

function Footer(): React.JSX.Element {
  return (
    <footer className="py-10">
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          {/* Unlike the header marks, this one has no hidden label beside it. */}
          <Logo title="Flowdesk" />

          <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-2">
            <a
              href="mailto:hello@flowdesk.gh"
              className="text-sm text-text-secondary hover:text-text-primary"
            >
              Contact
            </a>
            <Link to="/privacy" className="text-sm text-text-secondary hover:text-text-primary">
              Privacy
            </Link>
            <Link to="/terms" className="text-sm text-text-secondary hover:text-text-primary">
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
