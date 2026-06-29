import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from '@/components/shared/Layout';
import LandingPage from '@/pages/Landing';
import OrdersPage from '@/pages/Orders';
import LoginPage from '@/pages/Login';
import RegisterPage from '@/pages/Register';
import DashboardPage from '@/pages/Dashboard';
import CustomersPage from '@/pages/Customers';
import CustomerProfilePage from '@/pages/CustomerProfile';
import ProductsPage from '@/pages/Products';
import PaymentsPage from '@/pages/Payments';
import MessagesPage from '@/pages/Messages';
import StaffPage from '@/pages/Staff';
import SettingsPage from '@/pages/Settings';
import { isAuthenticated } from '@/hooks/useAuth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Index route — sends auth'd users to /dashboard, everyone else to the landing page.
 * Uses window.location.replace on the auth'd branch so that the dashboard renders
 * without the IndexRedirect component sticking around in history.
 */
function IndexRedirect(): React.JSX.Element {
  useEffect(() => {
    if (isAuthenticated()) {
      window.location.replace('/dashboard');
    }
  }, []);
  return <LandingPage />;
}

/**
 * Gates the entire dashboard tree on the presence of an access token.
 * Redirects to /login until the user is authenticated. Login page itself bounces
 * authed users back to /dashboard so this never deadlocks.
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
        <Routes>
          <Route path="/" element={<IndexRedirect />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
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
          <Route path="*" element={<LandingPage />} />
       </Routes>
     </BrowserRouter>
   </QueryClientProvider>
  );
}
