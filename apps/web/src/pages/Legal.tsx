import { Link } from 'react-router-dom';

/**
 * Privacy policy and terms.
 *
 * The footer links to these because a product that handles customer phone
 * numbers and payment records needs them, and a dead link in a footer is worse
 * than no link at all.
 *
 * The body text is deliberately not written here. Privacy and terms copy is a
 * legal document specific to this business, its jurisdiction and its data
 * processors — it is not something to generate. Replace the `sections` below
 * with the reviewed text before launch.
 */

type LegalKind = 'privacy' | 'terms';

const CONTENT: Record<LegalKind, { title: string; intro: string; sections: string[] }> = {
  privacy: {
    title: 'Privacy policy',
    intro:
      'How Flowdesk collects, stores and uses the information that passes through your WhatsApp Business number.',
    sections: [
      'What we collect',
      'How WhatsApp message data is handled',
      'Who we share data with, and why',
      'How long we keep it',
      'Your rights, and how to exercise them',
      'How to contact us',
    ],
  },
  terms: {
    title: 'Terms of service',
    intro: 'The agreement between your business and Flowdesk.',
    sections: [
      'Who may use Flowdesk',
      'Your account and your staff accounts',
      'Billing, trials and cancellation',
      'Acceptable use',
      'Availability and support',
      'Liability and governing law',
    ],
  },
};

export default function LegalPage({ kind }: { kind: LegalKind }): React.JSX.Element {
  const content = CONTENT[kind];

  return (
    <div className="min-h-[100dvh] bg-background px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <Link
          to="/"
          className="text-sm text-text-secondary underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
        >
          Back to Flowdesk
        </Link>

        <h1 className="mt-8 text-display-sm font-extrabold tracking-tighter text-text-primary">{content.title}</h1>
        <p className="mt-4 text-base leading-relaxed text-text-secondary">{content.intro}</p>

        <p
          role="note"
          className="mt-8 rounded-lg border border-warning-border bg-warning-muted px-4 py-3 text-sm text-text-secondary"
        >
          This document has not been published yet. Until it is, write to{' '}
          <a href="mailto:hello@flowdesk.gh" className="font-medium underline underline-offset-[3px]">
            hello@flowdesk.gh
          </a>{' '}
          and we will send you the current version.
        </p>

        <h2 className="fd-label mt-10">What this document will cover</h2>
        <ol className="mt-3 divide-y divide-border-subtle border-y border-border-subtle">
          {content.sections.map((section, i) => (
            <li key={section} className="flex items-baseline gap-3 py-3">
              <span className="fd-figure text-xs text-text-muted">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-base text-text-primary">{section}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
