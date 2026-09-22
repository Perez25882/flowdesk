import { readImageDimensions, type ImageDimensions } from '../s3/media.js';

/**
 * What a product photo is allowed to be.
 *
 * The list is short on purpose. These three are what a phone camera and every
 * WhatsApp client produce, and they are exactly the still formats Meta accepts
 * for an outbound image message — so anything that passes here can actually be
 * sent to a customer later, rather than failing at the one moment it matters.
 * HEIC is deliberately absent: iPhones upload it, Meta rejects it, and
 * converting it would cost a native dependency for a format the browser's own
 * file picker already re-encodes on upload.
 */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * Meta's own ceiling for an image message is 5 MB. Storing anything larger
 * would mean accepting a photo the shop can never send, so the cap is the same
 * number rather than a friendlier one.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface InspectedImage {
  buffer: Buffer;
  mimeType: AllowedImageType;
  sizeBytes: number;
  dimensions: ImageDimensions | null;
}

export type ImageRejection =
  | 'not_an_image'
  | 'unsupported_format'
  | 'too_large'
  | 'empty'
  | 'malformed_encoding';

export type InspectionResult =
  | { ok: true; image: InspectedImage }
  | { ok: false; reason: ImageRejection };

/**
 * Turns an uploaded payload into bytes we are willing to keep.
 *
 * The declared content type is ignored entirely and the format is read from the
 * file's own header. A client that says `image/png` decides nothing: the upload
 * route is authenticated but a shop's own staff account is still the likeliest
 * way something unpleasant gets into the bucket, and an object whose extension
 * disagrees with its contents is how a "photo" ends up being served back as
 * something the browser will execute.
 */
export function inspectImageUpload(encoded: string): InspectionResult {
  const base64 = stripDataUrlPrefix(encoded).trim();
  if (base64.length === 0) return { ok: false, reason: 'empty' };

  // Base64 inflates by 4/3, so the encoded length bounds the decoded size. This
  // is checked before decoding so an oversized upload never becomes an
  // oversized Buffer in memory first.
  if (base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
    return { ok: false, reason: 'too_large' };
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, reason: 'malformed_encoding' };
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return { ok: false, reason: 'empty' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too_large' };

  const mimeType = sniffImageType(buffer);
  if (!mimeType) {
    // Separated so the owner gets a message they can act on. "That is not an
    // image" is useless to someone who just picked a photo out of their camera
    // roll on an iPhone; "save it as JPG first" is the whole answer.
    return { ok: false, reason: isRecognisedButUnusableImage(buffer) ? 'unsupported_format' : 'not_an_image' };
  }

  return {
    ok: true,
    image: {
      buffer,
      mimeType,
      sizeBytes: buffer.length,
      dimensions: readImageDimensions(buffer) ?? readWebpDimensions(buffer),
    },
  };
}

/** Accepts both a bare base64 string and a `data:image/jpeg;base64,...` URL. */
function stripDataUrlPrefix(encoded: string): string {
  const comma = encoded.indexOf(',');
  if (encoded.startsWith('data:') && comma !== -1) {
    return encoded.slice(comma + 1);
  }
  return encoded;
}

/**
 * The format, read from the file's magic bytes.
 *
 * Returns null for anything not on the allow-list, which covers both "this is
 * not an image" and "this is an image we cannot send" — the caller separates
 * the two by length so the owner gets a message that says which.
 */
export function sniffImageType(buffer: Buffer): AllowedImageType | null {
  if (buffer.length < 12) return null;

  // JPEG: SOI marker.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: the 8-byte signature, including the CRLF pair that detects a transfer
  // which mangled line endings.
  if (
    buffer[0] === 0x89 &&
    buffer.toString('ascii', 1, 4) === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: a RIFF container whose form type is WEBP.
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

/**
 * Formats that are genuinely images but that we will not store.
 *
 * Every one of these is something a person plausibly picked out of a photo
 * library — HEIC above all, since it is the iPhone default — and every one is
 * something Meta refuses in an image message. Identifying them is worth the few
 * lines because it is the difference between telling the owner their file is
 * not an image and telling them to save it as a JPG.
 */
function isRecognisedButUnusableImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  // GIF87a / GIF89a.
  if (buffer.toString('ascii', 0, 3) === 'GIF') return true;

  // BMP.
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true;

  // TIFF, both byte orders.
  const tiffLE = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a;
  const tiffBE = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00;
  if (tiffLE || tiffBE) return true;

  // ISO base media container — HEIC, HEIF and AVIF all live here, identified by
  // the brand that follows the `ftyp` box type.
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    return ['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].includes(brand);
  }

  return false;
}

/**
 * WebP dimensions, for the three chunk layouts the format defines.
 *
 * `readImageDimensions` in the S3 module covers PNG and JPEG and is left alone:
 * it exists to score inbound screenshots by aspect ratio, and widening it for a
 * format Meta never sends inbound would be changing one caller's function for
 * another caller's reason.
 */
export function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (sniffImageType(buffer) !== 'image/webp' || buffer.length < 30) return null;

  const chunk = buffer.toString('ascii', 12, 16);

  // Lossy: 'VP8 ' — a 3-byte frame tag, a 3-byte start code, then 14-bit
  // dimensions with 2 scaling bits above them.
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  // Lossless: 'VP8L' — 14-bit width and height, minus one, packed across the
  // four bytes that follow the 0x2f signature.
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // Extended: 'VP8X' — 24-bit canvas dimensions, minus one, little-endian.
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16)) + 1,
      height: (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16)) + 1,
    };
  }

  return null;
}

/** What the owner is told when an upload is refused. */
export function describeRejection(reason: ImageRejection): string {
  switch (reason) {
    case 'empty':
      return 'That file was empty.';
    case 'too_large':
      return 'Photos must be under 5 MB — WhatsApp will not send anything larger.';
    case 'malformed_encoding':
      return 'That file could not be read. Please pick it again.';
    case 'unsupported_format':
      return 'Photos must be JPG, PNG or WebP. If this came from an iPhone, save it as JPG first.';
    case 'not_an_image':
      return 'That file is not an image.';
  }
}
