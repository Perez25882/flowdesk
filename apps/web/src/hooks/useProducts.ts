import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



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

export function useProducts(search?: string): UseQueryResult<Product[], Error> {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  return useQuery({
    queryKey: ['products', search],
    queryFn: () => apiFetch<Product[]>(`/products${query}`),
    staleTime: 30_000,
  });
}

export function useProductDetail(productId: string | null): UseQueryResult<Product, Error> {
  return useQuery({
    queryKey: ['products', 'detail', productId],
    queryFn: () => apiFetch<Product>(`/products/${productId}`),
    enabled: !!productId,
    staleTime: 30_000,
  });
}

export function useCreateProduct(): UseMutationResult<Product, Error, CreateProductInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProductInput) =>
      apiFetch<Product>('/products', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProduct(): UseMutationResult<Product, Error, { id: string; data: Partial<CreateProductInput> }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateProductInput> }) =>
      apiFetch<Product>(`/products/${id}`, { method: 'PATCH', body: data }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'detail', id] });
    },
  });
}

export function useDeleteProduct(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useLowStockProducts(): UseQueryResult<Product[], Error> {
  return useQuery({
    queryKey: ['products', 'low-stock'],
    queryFn: () => apiFetch<Product[]>('/products/low-stock'),
    staleTime: 30_000,
  });
}

export function useAdjustStock(): UseMutationResult<Product, Error, { id: string; data: StockAdjustmentInput }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: StockAdjustmentInput }) =>
      apiFetch<Product>(`/products/${id}/stock`, { method: 'POST', body: data }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'detail', id] });
    },
  });
}
