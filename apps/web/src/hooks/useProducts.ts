import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiFetch, apiFetchBlob } from '@/lib/api';



/**
 * A product photo.
 *
 * `path` is an API path, not something an `<img src>` can load: the access
 * token is held in memory rather than in a cookie, so the browser's own image
 * request would arrive without it. `useProductImage` fetches the bytes through
 * the API client and hands back a Blob URL.
 */
export interface ProductImage {
  id: string;
  position: number;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  path: string;
  createdAt: string;
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
  /** Ordered; the first is the one a customer is sent. Absent on older payloads. */
  images?: ProductImage[];
  /** The lowest the assistant may agree to, or null when this item is fixed price. */
  floorPrice?: number | null;
  discountPercent?: number | null;
  discountLabel?: string | null;
  /** ISO 8601. */
  discountEndsAt?: string | null;
  tiers?: Array<{ minQuantity: number; percentOff: number }>;
}

export interface ProductPricingInput {
  floorPrice?: number | null;
  discountPercent?: number | null;
  discountLabel?: string | null;
  /** ISO 8601, or null to clear. */
  discountEndsAt?: string | null;
  /** Sent whole: what is here replaces whatever the product had. */
  tiers?: Array<{ minQuantity: number; percentOff: number }>;
}

export interface CreateProductInput extends ProductPricingInput {
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

// ── Photos ──────────────────────────────────────────────────────────────────

/**
 * Meta's own ceiling for an image message, mirrored here so the browser can say
 * no before spending a minute uploading something the API will refuse.
 */
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp';

/**
 * Reads a picked file as the base64 payload the API expects.
 *
 * `FileReader` produces a `data:` URL, which the API accepts as-is, the prefix
 * is stripped server-side, and the format is then read from the bytes rather
 * than from that prefix, so nothing here needs to be trusted.
 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

export function useProductImages(productId: string | null): UseQueryResult<ProductImage[], Error> {
  return useQuery({
    queryKey: ['products', 'images', productId],
    queryFn: () => apiFetch<ProductImage[]>(`/products/${productId}/images`),
    enabled: !!productId,
    staleTime: 30_000,
  });
}

export function useUploadProductImage(): UseMutationResult<
  ProductImage,
  Error,
  { productId: string; file: File }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, file }: { productId: string; file: File }) => {
      if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
        throw new Error('Photos must be under 5 MB. WhatsApp will not send anything larger.');
      }
      const data = await readFileAsDataUrl(file);
      return apiFetch<ProductImage>(`/products/${productId}/images`, {
        method: 'POST',
        body: { data },
      });
    },
    onSuccess: (_image, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'images', productId] });
    },
  });
}

export function useDeleteProductImage(): UseMutationResult<
  void,
  Error,
  { productId: string; imageId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, imageId }: { productId: string; imageId: string }) =>
      apiFetch<void>(`/products/${productId}/images/${imageId}`, { method: 'DELETE' }),
    onSuccess: (_void, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'images', productId] });
    },
  });
}

/**
 * Reorders a product's photos.
 *
 * The API requires the complete list, so a stale tab is refused rather than
 * half-applied. The caller therefore sends the order it just rendered, never a
 * subset.
 */
export function useReorderProductImages(): UseMutationResult<
  ProductImage[],
  Error,
  { productId: string; imageIds: string[] }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, imageIds }: { productId: string; imageIds: string[] }) =>
      apiFetch<ProductImage[]>(`/products/${productId}/images/order`, {
        method: 'PATCH',
        body: { imageIds },
      }),
    onSuccess: (_images, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products', 'images', productId] });
    },
  });
}

export interface LoadedImage {
  src: string | null;
  isLoading: boolean;
}

/**
 * Loads one photo's bytes as an object URL.
 *
 * The same shape as `usePaymentScreenshot`, and for the same reason: an
 * in-memory access token means the browser cannot fetch a protected image on
 * its own. The URL is revoked on unmount and whenever the path changes , 
 * without that, a catalogue of two hundred thumbnails would pin every one of
 * them in memory for the life of the tab.
 */
export function useProductImage(path: string | null): LoadedImage {
  const [state, setState] = useState<LoadedImage>({ src: null, isLoading: path !== null });

  useEffect(() => {
    if (!path) {
      setState({ src: null, isLoading: false });
      return;
    }

    let objectUrl: string | null = null;
    let live = true;
    setState({ src: null, isLoading: true });

    apiFetchBlob(path)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!live) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setState({ src: objectUrl, isLoading: false });
      })
      .catch(() => {
        // A photo that will not load is a missing thumbnail, not an error
        // worth interrupting the catalogue for. The placeholder stands in.
        if (live) setState({ src: null, isLoading: false });
      });

    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}

// ── Catalogue import ────────────────────────────────────────────────────────

export interface ImportRow {
  line: number;
  name: string;
  unit: string;
  price: number;
  stockQuantity: number;
  reorderThreshold: number;
  aliases: string[];
  sku: string | null;
  existingProductId: string | null;
}

export interface ImportRowError {
  line: number;
  raw: string;
  message: string;
}

export interface ImportPreview {
  rows: ImportRow[];
  errors: ImportRowError[];
  summary: {
    toCreate: number;
    toUpdate: number;
    failed: number;
    allowed: number | null;
    wouldExceedPlan: boolean;
  };
}

export interface ImportResult {
  created: number;
  updated: number;
  failed: ImportRowError[];
}

export function usePreviewImport(): UseMutationResult<ImportPreview, Error, string> {
  return useMutation({
    mutationFn: (csv: string) =>
      apiFetch<ImportPreview>('/products/import/preview', { method: 'POST', body: { csv } }),
  });
}

export function useCommitImport(): UseMutationResult<
  ImportResult,
  Error,
  { csv: string; updateExisting: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { csv: string; updateExisting: boolean }) =>
      apiFetch<ImportResult>('/products/import', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

/**
 * Reads a picked file as text.
 *
 * `readAsText` with no encoding argument assumes UTF-8, which is what every
 * modern export writes and what the parser strips a BOM from. A file saved as
 * Windows-1252 will mangle accented characters, rare enough in a Ghanaian
 * catalogue to accept, and the alternative is shipping an encoding detector.
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsText(file);
  });
}
