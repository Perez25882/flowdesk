import { BrowserRouter, Routes, Route } from 'react-router-dom';
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<Layout />}>
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
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
