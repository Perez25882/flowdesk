import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { isAuthenticated } from '@/hooks/useAuth';
import Wordmark from '@/components/marketing/Wordmark';

/**
 * A real 404.
 *
 * The router previously sent every unmatched path to the landing page, so a
 * signed-in owner who mistyped a URL was silently shown a marketing page
 * inviting them to start a free trial they are already paying for. That reads
 * as a broken product.
 *
 * This says what happened and offers the way back that fits who is asking.
 */
export default function NotFoundPage(): React.JSX.Element {
  const navigate = useNavigate();
  const authed = isAuthenticated();

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background px-5 py-6 sm:px-8">
      <header>
        <Link
          to="/"
          className="inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Wordmark />
          <span className="sr-only">Flowdesk home</span>
        </Link>
      </header>

      <main className="flex flex-1 items-center">
        <div className="max-w-prose">
          <p className="fd-figure text-sm font-semibold text-primary">404</p>

          <h1 className="mt-3 text-display-md font-extrabold tracking-tighter text-text-primary">
            That page does not exist.
          </h1>

          <p className="mt-4 text-base leading-relaxed text-text-secondary">
Nothing has been lost. Your orders, payments and customers are where you left them.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button size="lg" onClick={() => navigate(authed ? '/dashboard' : '/')}>
              {authed ? 'Back to today' : 'Back to the home page'}
            </Button>
            <Button variant="link" onClick={() => navigate(-1)}>
              Go back one page
            </Button>
          </div>
        </div>
      </main>

      <footer>
        <p className="text-xs text-text-muted">
          Still stuck?{' '}
          <a href="mailto:hello@flowdesk.gh" className="underline underline-offset-[3px]">
            hello@flowdesk.gh
          </a>
        </p>
      </footer>
    </div>
  );
}
