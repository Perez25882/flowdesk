import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { restoreSession } from './lib/api';
import './styles/globals.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

function mount(): void {
  ReactDOM.createRoot(rootElement!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

/**
 * Resume the session before the first render.
 *
 * The access token lives in memory only, so a page reload starts signed out.
 * Exchanging the httpOnly refresh cookie for a fresh token here means a reload
 * lands on the dashboard instead of bouncing to sign-in, without any
 * long-lived credential ever being readable by JavaScript.
 *
 * Failure needs no special handling: the app renders signed-out and the router
 * redirects, which is the correct outcome.
 */
restoreSession().finally(mount);
