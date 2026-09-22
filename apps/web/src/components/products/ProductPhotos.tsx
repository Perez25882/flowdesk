import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Star, Trash2 } from 'lucide-react';
import {
  ACCEPTED_IMAGE_TYPES,
  useDeleteProductImage,
  useProductImage,
  useProductImages,
  useReorderProductImages,
  useUploadProductImage,
  type ProductImage,
} from '@/hooks/useProducts';
import { cn } from '@/lib/utils';

/** Six is the API's limit; the UI says so before the upload rather than after. */
const MAX_PHOTOS = 6;

/**
 * One photo, loaded through the API client.
 *
 * Its own component because each thumbnail owns a Blob URL that has to be
 * revoked when it goes away, and a hook cannot be called in a loop from the
 * parent.
 */
function Thumbnail({
  image,
  alt,
  className,
}: {
  image: ProductImage;
  alt: string;
  className?: string;
}): React.JSX.Element {
  const { src, isLoading } = useProductImage(image.path);

  if (src) {
    return <img src={src} alt={alt} className={cn('h-full w-full object-cover', className)} />;
  }

  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center bg-surface-hover',
        isLoading && 'animate-pulse',
        className,
      )}
      aria-hidden="true"
    />
  );
}

/** The first photo of a product, for the catalogue list. */
export function ProductThumbnail({
  image,
  name,
}: {
  image: ProductImage | undefined;
  name: string;
}): React.JSX.Element {
  return (
    <span className="flex h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-surface-hover sm:h-10 sm:w-10">
      {image ? (
        <Thumbnail image={image} alt={name} />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-text-muted">
          <ImagePlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

/**
 * The photo strip inside the product form.
 *
 * Reordering is arrows rather than drag-and-drop on purpose: this is used on a
 * phone, one-handed, often while standing in a shop, and a drag target small
 * enough to fit next to a thumbnail is a drag target nobody can hit. The first
 * photo is marked, because that is the one a customer is actually sent.
 */
export default function ProductPhotos({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}): React.JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: images, isLoading } = useProductImages(productId);
  const upload = useUploadProductImage();
  const remove = useDeleteProductImage();
  const reorder = useReorderProductImages();

  const photos = images ?? [];
  const isFull = photos.length >= MAX_PHOTOS;

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setError(null);

    // Uploaded one at a time rather than in parallel. The API assigns each
    // photo the next free position, and concurrent uploads would race for the
    // same one, which on a first upload decides which picture the customer
    // gets sent.
    const room = MAX_PHOTOS - photos.length;
    for (const file of Array.from(files).slice(0, room)) {
      try {
        await upload.mutateAsync({ productId, file });
      } catch (uploadError: unknown) {
        setError(uploadError instanceof Error ? uploadError.message : 'That photo could not be saved.');
        break;
      }
    }

    if (files.length > room) {
      setError(`Only ${MAX_PHOTOS} photos per product. The rest were not added.`);
    }

    if (fileInput.current) fileInput.current.value = '';
  }

  function move(index: number, direction: -1 | 1): void {
    const next = [...photos];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate({ productId, imageIds: next.map((photo) => photo.id) });
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-text-primary">Photos</span>

      <div className="flex flex-wrap items-start gap-2">
        {isLoading && (
          <span className="h-20 w-20 animate-pulse rounded-lg border border-border bg-surface-hover" />
        )}

        {photos.map((photo, index) => (
          <figure
            key={photo.id}
            className="group relative h-20 w-20 overflow-hidden rounded-lg border border-border"
          >
            <Thumbnail image={photo} alt={`${productName}, photo ${index + 1}`} />

            {index === 0 && (
              <figcaption className="absolute inset-x-0 top-0 flex items-center gap-1 bg-black/55 px-1.5 py-0.5 text-2xs font-medium text-white">
                <Star className="h-2.5 w-2.5 fill-current" strokeWidth={0} aria-hidden="true" />
                Sent first
              </figcaption>
            )}

            <div className="absolute inset-x-0 bottom-0 flex items-stretch bg-black/55">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0 || reorder.isPending}
                aria-label={`Move photo ${index + 1} of ${productName} earlier`}
                className="flex flex-1 items-center justify-center py-1 text-white/90 transition-colors hover:bg-black/40 disabled:opacity-30"
              >
                <ArrowLeft className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === photos.length - 1 || reorder.isPending}
                aria-label={`Move photo ${index + 1} of ${productName} later`}
                className="flex flex-1 items-center justify-center py-1 text-white/90 transition-colors hover:bg-black/40 disabled:opacity-30"
              >
                <ArrowRight className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => remove.mutate({ productId, imageId: photo.id })}
                disabled={remove.isPending}
                aria-label={`Remove photo ${index + 1} of ${productName}`}
                className="flex flex-1 items-center justify-center py-1 text-white/90 transition-colors hover:bg-danger/80 disabled:opacity-30"
              >
                <Trash2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </figure>
        ))}

        {!isFull && (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={upload.isPending}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-text-muted transition-colors duration-fast ease-out hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <ImagePlus className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-2xs">{upload.isPending ? 'Adding…' : 'Add photo'}</span>
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple
        className="sr-only"
        onChange={(event) => void handleFiles(event.target.files)}
      />

      <p className="text-xs text-text-muted">
        {photos.length === 0
          ? 'Customers who ask to see this item are sent the first photo automatically.'
          : `${photos.length} of ${MAX_PHOTOS}. JPG, PNG or WebP, under 5 MB each.`}
      </p>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export { MAX_PHOTOS };
