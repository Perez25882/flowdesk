import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LandingPage from '@/pages/Landing';
import LoginPage from '@/pages/Login';
import { isAuthenticated } from '@/hooks/useAuth';

/**
 * Route-level code splitting.
 *
 * The target market is on 3G, where a single large bundle is the difference
 * between a usable dashboard and an abandoned one. Landing and login load
 * eagerly because they are the entry points; everything behind authentication
 * is fetched on demand.
 */
const RegisterPage = lazy(() => import('@/pages/Register'));
const NotFoundPage = lazy(() => import('@/pages/NotFound'));
const LegalPage = lazy(() => import('@/pages/Legal'));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPassword'));
const ResetPasswordPage = lazy(() => import('@/pages/ResetPassword'));
const StaffAcceptPage = lazy(() => import('@/pages/StaffAccept'));

const Layout = lazy(() => import('@/components/shared/Layout'));
const DashboardPage = lazy(() => import('@/pages/Dashboard'));
const OrdersPage = lazy(() => import('@/pages/Orders'));
const CustomersPage = lazy(() => import('@/pages/Customers'));
const CustomerProfilePage = lazy(() => import('@/pages/CustomerProfile'));
const ProductsPage = lazy(() => import('@/pages/Products'));
const PaymentsPage = lazy(() => import('@/pages/Payments'));
const MessagesPage = lazy(() => import('@/pages/Messages'));
const StaffPage = lazy(() => import('@/pages/Staff'));
const SettingsPage = lazy(() => import('@/pages/Settings'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // The shared API client already redirects on an unrecoverable 401, so
      // retrying an auth failure only delays that.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

/** Full-screen fallback shown while a route chunk is downloading. */
function RouteFallback(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[100dvh] items-center justify-center bg-background"
    >
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** Sends authenticated visitors to the dashboard; everyone else sees the landing page. */
function IndexRoute(): React.JSX.Element {
  const authed = isAuthenticated();

  useEffect(() => {
    if (authed) {
      window.location.replace('/dashboard');
    }
  }, [authed]);

  return authed ? <RouteFallback /> : <LandingPage />;
}

/**
 * Gates the dashboard on the presence of an access token.
 *
 * This is a UX guard, not a security boundary — every API request is
 * authorised server-side regardless of what the client renders.
 */
function RequireAuth({ children }: { children: React.JSX.Element }): React.JSX.Element {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export default function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<IndexRoute />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/staff/accept" element={<StaffAcceptPage />} />

            <Route path="/privacy" element={<LegalPage kind="privacy" />} />
            <Route path="/terms" element={<LegalPage kind="terms" />} />

            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/customers/:id" element={<CustomerProfilePage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/payments" element={<PaymentsPage />} />
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/staff" element={<StaffPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            {/* An unmatched path used to fall through to the landing page,
                which showed a paying customer a free-trial pitch whenever they
                mistyped a URL. */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
