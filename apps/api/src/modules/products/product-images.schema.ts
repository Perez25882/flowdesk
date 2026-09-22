import { z } from 'zod';
import { MAX_IMAGE_BYTES } from '../../services/media/image-file.js';

/**
 * A photo, as the dashboard sends it.
 *
 * Base64 in a JSON body rather than multipart. The practical difference at this
 * size is a third more bytes on the wire for a file already capped at 5 MB, and
 * in exchange the upload travels through the same authenticated JSON pipeline,
 * the same error envelope and the same Zod validation as everything else in the
 * API — no second parser, no second way for a request to be malformed.
 *
 * `data` is deliberately not validated for shape here: what makes an upload
 * acceptable is its magic bytes, not its string, and that check lives in
 * `inspectImageUpload` where the buffer exists. Zod only bounds the length so a
 * hopeless payload is refused before anything decodes it.
 */
export const UploadProductImageSchema = z.object({
  /** Bare base64, or a `data:image/...;base64,` URL as `FileReader` produces. */
  data: z
    .string()
    .min(1, 'No image data was sent')
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256, 'That photo is too large'),
});

export const ReorderProductImagesSchema = z.object({
  /**
   * Every one of the product's image ids, in the order they should appear.
   * A partial list is refused rather than half-applied — see the service.
   */
  imageIds: z.array(z.string().min(1)).min(1),
});

export type UploadProductImageInput = z.infer<typeof UploadProductImageSchema>;
export type ReorderProductImagesInput = z.infer<typeof ReorderProductImagesSchema>;
