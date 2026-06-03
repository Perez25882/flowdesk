import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API_BASE = '/api/v1';

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('accessToken');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.data as T;
}

export interface Product {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  price: number;
  stockQuantity: number;
  reorderThreshold: number;
  aliases: string[];
  active: boolean;
}

export interface CreateProductInput {
  name: string;
  unit: string;
  price: number;
  stockQuantity?: number;
  reorderThreshold?: number;
  aliases?: string[];
  sku?: string;
}

export interface StockAdjustmentInput {
  quantity: number;
  type: 'RESTOCK' | 'ADJUSTMENT';
  note?: string;
}

export function useProducts(search?: string) {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  return useQuery({
    queryKey: ['products', search],
    queryFn: () => fetchJson<Product[]>(`/products${query}`),
    staleTime: 30_000,
  });
}

export function useProductDetail(productId: string | null) {
  return useQuery({
    queryKey: ['products', 'detail', productId],
    queryFn: () => fetchJson<Product>(`/products/${productId}`),
    enabled: !!productId,
    staleTime: 30_000,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProductInput) =>
      fetchJson<Product>('/products', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateProductInput> }) =>
      fetchJson<Product>(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'detail', id] });
    },
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<void>(`/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useLowStockProducts() {
  return useQuery({
    queryKey: ['products', 'low-stock'],
    queryFn: () => fetchJson<Product[]>('/products/low-stock'),
    staleTime: 30_000,
  });
}

export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: StockAdjustmentInput }) =>
      fetchJson<Product>(`/products/${id}/stock`, { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'detail', id] });
    },
  });
}
