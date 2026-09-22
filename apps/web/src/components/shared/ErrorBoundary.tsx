import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error and shows it, instead of unmounting the app.
 *
 * Without one of these, any exception thrown while rendering takes React's
 * whole tree down and leaves a white page with the URL still in the bar. That
 * is the worst failure mode a product can have: it is indistinguishable from a
 * dead server, a bad deploy, a lost session or a broken network, so the owner
 * cannot tell you anything useful and neither can a screenshot.
 *
 * In development the message and stack are shown outright, because the person
 * looking at the screen is the person who can fix it. In production the owner
 * gets a way out and the detail goes to the console, since a Ghanaian shop
 * owner at 6am needs a working button rather than a component stack.
 */

interface Props {
  children: ReactNode;
  /** Names the area, so an error in one panel does not read as total failure. */
  label?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Kept even in production: this is the only copy of the component stack,
    // and it is what turns "it went blank" into a bug report.
    console.error('[flowdesk] render error', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null, info: null });
  };

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const dev = import.meta.env.DEV;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-border-subtle bg-surface p-7 shadow-lg">
          <h1 className="text-xl font-extrabold tracking-tight text-text-primary">
            {this.props.label ? `${this.props.label} could not load` : 'Something went wrong'}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            The rest of Flowdesk is still running. Reloading usually clears it.
          </p>

          {dev && (
            <>
              <pre className="mt-5 max-h-48 overflow-auto rounded-md bg-surface-sunken p-3 text-xs leading-relaxed text-danger">
                {error.name}: {error.message}
              </pre>
              {info?.componentStack && (
                <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-surface-sunken p-3 text-2xs leading-relaxed text-text-secondary">
                  {info.componentStack.trim()}
                </pre>
              )}
            </>
          )}

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-contrast hover:bg-primary-hover"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-semibold text-text-primary hover:bg-surface-hover"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
