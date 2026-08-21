import { Link } from 'react-router-dom';

/**
 * Privacy policy and terms of service.
 *
 * These are DRAFTS. They were written against what the code actually does —
 * what is collected, where it goes, who processes it — rather than from a
 * generic template, so the factual claims are accurate. They have not been
 * reviewed by a lawyer, and they must be before launch.
 *
 * Every value a lawyer or the founder has to supply is a `[[TOKEN]]` below.
 * They render visibly on the page on purpose: a placeholder that looks like
 * finished copy is how a company ships its own address as "123 Example Street".
 * `MISSING_DETAILS` lists them in one place — grep for `[[` before going live.
 */

type LegalKind = 'privacy' | 'terms';

/** Everything that must be filled in before these pages are publishable. */
const MISSING_DETAILS = [
  '[[REGISTERED_COMPANY_NAME]]',
  '[[REGISTERED_ADDRESS]]',
  '[[COMPANY_REGISTRATION_NUMBER]]',
  '[[DPC_REGISTRATION_NUMBER]]',
  '[[SUPPORT_EMAIL]]',
  '[[EFFECTIVE_DATE]]',
] as const;

interface Section {
  heading: string;
  paragraphs: string[];
}

const PRIVACY: Section[] = [
  {
    heading: 'Who we are',
    paragraphs: [
      'Flowdesk is operated by [[REGISTERED_COMPANY_NAME]], a company registered in Ghana under number [[COMPANY_REGISTRATION_NUMBER]], with its registered office at [[REGISTERED_ADDRESS]]. We are registered with the Data Protection Commission of Ghana under [[DPC_REGISTRATION_NUMBER]].',
      'This policy explains what we do with personal data. It covers two different relationships, and the difference matters, so it is set out plainly in the next section.',
    ],
  },
  {
    heading: 'Two relationships: your business, and your customers',
    paragraphs: [
      'When you sign up for Flowdesk, we hold data about you and your business — your name, email address, phone number, business details and billing records. For that data we are the data controller under the Data Protection Act, 2012 (Act 843).',
      'When your customers message your WhatsApp Business number, we store and process what they send on your behalf. For that data you are the controller and Flowdesk is your processor. You decide why it is collected and what happens to it; we act on your instructions and on the terms of this agreement. That means your customers exercise their rights through you, and we help you answer them.',
      'If you are a customer of a business that uses Flowdesk and you want your data removed, contact that business. If you cannot reach them, write to [[SUPPORT_EMAIL]] and we will help you identify who holds it.',
    ],
  },
  {
    heading: 'What we collect',
    paragraphs: [
      'From the business owner and staff: name, email address, phone number, a hashed password, business name and type, and the settings you configure. We record which staff member performed actions inside the product, so an owner can see who did what.',
      'From WhatsApp: for every message sent to your business number, we store the sender phone number, the message contents, the message type, its Meta message identifier and its timestamp. Images, audio, video and documents sent to you are stored so they do not disappear when Meta expires them. We also store the WhatsApp profile name where Meta supplies it.',
      'Derived from those messages: customer records, orders, payment records, and the classification the system assigned to each message.',
      'Billing: we do not store card numbers. Card and mobile money details are handled by Paystack; we hold only the customer and subscription identifiers Paystack returns to us, and a record of what was charged.',
      'Technical: IP address, browser user agent and session records, used for security, rate limiting and diagnosing faults.',
    ],
  },
  {
    heading: 'Automated replies, and the AI that writes them',
    paragraphs: [
      'Flowdesk generates replies to your customers on your behalf. To do that, the text of a customer message is sent to a large language model hosted by NVIDIA, together with the catalogue rows and business details needed to answer it. Those are the only records shared; we do not send your full customer list, your order history or your financial data.',
      'The model provider processes the message to generate a response and does not use it to train models. Replies are checked against your own records before they are sent, and prices always come from your catalogue rather than from the model.',
      'No decision with a legal or similarly significant effect on a person is made by the system alone. Orders, cancellations and payments are confirmed by you or your staff.',
    ],
  },
  {
    heading: 'Who else processes your data',
    paragraphs: [
      'Meta Platforms — the WhatsApp Business Platform, which delivers the messages themselves.',
      'NVIDIA — the language model that drafts replies, as described above.',
      'Paystack — card and mobile money payments for your Flowdesk subscription.',
      'Amazon Web Services — hosting and encrypted storage of media files.',
      'Our hosting and database providers, listed on request.',
      'We do not sell personal data, and we do not share it for advertising.',
    ],
  },
  {
    heading: 'Where data is stored, and for how long',
    paragraphs: [
      'Data is stored on servers outside Ghana, which means it is transferred internationally. We rely on contractual protections with each processor for those transfers.',
      'Message, order and payment records are kept for as long as your account is active, because they are your business records. If you close your account, we retain them for 30 days so the account can be restored by mistake, and then delete them permanently.',
      'Records we are required to keep for tax or accounting purposes are retained for the period the law requires, regardless of account closure.',
    ],
  },
  {
    heading: 'How we protect it',
    paragraphs: [
      'Data is encrypted in transit using TLS and at rest on our database and file storage. WhatsApp access tokens are additionally encrypted with a separate key before being written to the database. Passwords are stored as bcrypt hashes and never in a readable form.',
      'Each business is isolated from every other: staff access is limited by role, and every query is scoped to the business it belongs to.',
      'No system is perfectly secure. If a breach affects your data, we will notify you and the Data Protection Commission as the Act requires.',
    ],
  },
  {
    heading: 'Your rights',
    paragraphs: [
      'Under the Data Protection Act, 2012 (Act 843) you may ask us for a copy of the personal data we hold about you, ask us to correct it, ask us to delete it, object to how we use it, or withdraw consent where we relied on it.',
      'Write to [[SUPPORT_EMAIL]]. We will respond within 30 days. If you are not satisfied, you may complain to the Data Protection Commission of Ghana.',
    ],
  },
  {
    heading: 'Changes',
    paragraphs: [
      'If we change this policy in a way that materially affects you, we will tell you in the product and by email before it takes effect.',
    ],
  },
];

const TERMS: Section[] = [
  {
    heading: 'This agreement',
    paragraphs: [
      'These terms are between [[REGISTERED_COMPANY_NAME]] ("Flowdesk", "we") and the business that opens an account ("you"). By creating an account you accept them.',
      'You must be at least 18 years old and authorised to act for the business you are registering.',
    ],
  },
  {
    heading: 'What Flowdesk does',
    paragraphs: [
      'Flowdesk connects to your own WhatsApp Business number through Meta’s Embedded Signup, reads the messages your customers send you, turns them into orders, customer records and payment records, and can reply on your behalf.',
      'You keep your number. We do not take ownership of it, and you can disconnect it at any time from your settings.',
    ],
  },
  {
    heading: 'Your account and your staff',
    paragraphs: [
      'You are responsible for keeping your password secure and for everything done through your account, including by staff you invite. Staff you invite get access limited by the role you give them.',
      'Deactivate staff who leave. We give you the control; we cannot know when someone leaves.',
    ],
  },
  {
    heading: 'Automated replies are sent in your name',
    paragraphs: [
      'This is the most important thing in this document. When you enable automatic replies, messages are sent to your customers from your WhatsApp number, without you seeing them first. They are written from your catalogue, your prices and the business details you record, and they are checked against those records before being sent — but they are generated by software, and software makes mistakes.',
      'You choose how much it does. In draft mode it prepares replies for you to send. In automatic mode it answers grounded questions on its own and escalates anything about price negotiation, complaints or policy to you.',
      'Keep your catalogue, prices, stock and business details accurate. A reply built from a wrong price is a wrong price quoted to your customer in your name.',
      'You remain responsible for what is sent from your number, and for honouring what your customers are told.',
    ],
  },
  {
    heading: 'Meta’s rules apply too',
    paragraphs: [
      'Your use of the WhatsApp Business Platform is subject to Meta’s own terms and messaging policies. Meta can restrict or disable a number that breaches them, and if that happens Flowdesk cannot deliver messages for you.',
      'Do not use Flowdesk to send unsolicited marketing, and do not message people who have not contacted you first.',
    ],
  },
  {
    heading: 'Trials, billing and cancellation',
    paragraphs: [
      'New accounts get a 14-day free trial. No card is required to start it.',
      'When the trial ends, and for two days afterwards, the account keeps working. After that it becomes read-only until you choose a plan: you can still see everything, and nothing is deleted.',
      'Subscriptions are billed monthly in Ghana cedis through Paystack. Prices are shown before you pay, and we will give you at least 30 days’ notice by email before any price change.',
      'You can cancel at any time. Cancelling stops the next renewal; it does not refund the current month, and your account keeps working until the period you have paid for ends.',
      'If a payment fails we will retry and tell you. Your account is suspended three days after the final failure. Suspension does not delete your data.',
    ],
  },
  {
    heading: 'Acceptable use',
    paragraphs: [
      'Do not use Flowdesk to break the law, to send spam or malware, to impersonate anyone, to interfere with the service or to try to reach another business’s data.',
      'We may suspend an account that does any of these, and will tell you why.',
    ],
  },
  {
    heading: 'Your data',
    paragraphs: [
      'Your business records, your customers’ records and your message history are yours. We process them to run the service for you, as described in the privacy policy.',
      'You can export your data, and you can ask us to delete it. Thirty days after you close your account we delete it permanently.',
    ],
  },
  {
    heading: 'Availability',
    paragraphs: [
      'We aim for 99.5% monthly uptime, excluding scheduled maintenance we tell you about in advance and outages at Meta, our payment processor or our hosting providers.',
      'Flowdesk depends on WhatsApp. If Meta is down, messages will not arrive or be delivered, and that is outside our control. Incoming messages are stored and processed when service returns.',
    ],
  },
  {
    heading: 'Liability',
    paragraphs: [
      'Nothing here limits liability that cannot be limited by law, including for death, personal injury or fraud.',
      'Subject to that, our total liability to you in any twelve-month period is limited to the amount you paid us in that period. We are not liable for lost profits, lost business or lost data beyond what a backup would have restored.',
      'Flowdesk is provided as it is. We do not warrant that automatic replies will be correct in every case, which is why you can review them and why you control how much is sent automatically.',
    ],
  },
  {
    heading: 'Ending the agreement',
    paragraphs: [
      'You can close your account at any time from your settings. We may end this agreement with 30 days’ notice, or immediately if you breach these terms in a way that cannot be fixed.',
      'If we end it without your fault, we refund the unused part of the month.',
    ],
  },
  {
    heading: 'Governing law',
    paragraphs: [
      'These terms are governed by the laws of Ghana, and the courts of Ghana have exclusive jurisdiction.',
      'Questions: [[SUPPORT_EMAIL]].',
    ],
  },
];

const CONTENT: Record<LegalKind, { title: string; intro: string; sections: Section[] }> = {
  privacy: {
    title: 'Privacy policy',
    intro:
      'What Flowdesk does with the information that passes through your WhatsApp Business number, and with your own account details.',
    sections: PRIVACY,
  },
  terms: {
    title: 'Terms of service',
    intro: 'The agreement between your business and Flowdesk.',
    sections: TERMS,
  },
};

/** True while any `[[TOKEN]]` is still unfilled, which drives the draft banner. */
function hasUnfilledDetails(sections: Section[]): boolean {
  return sections.some((section) =>
    section.paragraphs.some((paragraph) => paragraph.includes('[[')),
  );
}

export default function LegalPage({ kind }: { kind: LegalKind }): React.JSX.Element {
  const content = CONTENT[kind];
  const isDraft = hasUnfilledDetails(content.sections);

  return (
    <div className="min-h-[100dvh] bg-background px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <Link
          to="/"
          className="text-sm text-text-secondary underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
        >
          Back to Flowdesk
        </Link>

        <h1 className="mt-8 text-display-sm font-extrabold tracking-tighter text-text-primary">
          {content.title}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-text-secondary">{content.intro}</p>

        {isDraft && (
          <p
            role="note"
            className="mt-8 border-l-2 border-warning-border bg-warning-muted px-4 py-3 text-sm text-text-secondary"
          >
            <strong className="font-semibold text-text-primary">Draft for review.</strong> This
            document is accurate about how Flowdesk works, but the company details in square
            brackets have not been filled in and it has not been reviewed by a lawyer. It is not
            yet binding.
          </p>
        )}

        <p className="mt-6 text-sm text-text-tertiary">Last updated [[EFFECTIVE_DATE]]</p>

        <div className="mt-10 space-y-10">
          {content.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-lg font-semibold tracking-tight text-text-primary">
                {section.heading}
              </h2>
              <div className="mt-3 space-y-3">
                {section.paragraphs.map((paragraph, index) => (
                  <p
                    key={index}
                    className="text-[0.9375rem] leading-relaxed text-text-secondary"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-14 border-t border-border-subtle pt-6 text-sm text-text-tertiary">
          The other document:{' '}
          <Link
            to={kind === 'privacy' ? '/terms' : '/privacy'}
            className="underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
          >
            {kind === 'privacy' ? 'Terms of service' : 'Privacy policy'}
          </Link>
        </p>
      </div>
    </div>
  );
}

export { MISSING_DETAILS };
