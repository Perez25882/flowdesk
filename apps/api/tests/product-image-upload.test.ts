import { describe, expect, it } from 'vitest';
import {
  inspectImageUpload,
  readWebpDimensions,
  sniffImageType,
  MAX_IMAGE_BYTES,
} from '../src/services/media/image-file.js';

/**
 * What the upload endpoint will accept into the bucket.
 *
 * The declared content type is never consulted, so these tests are written
 * against bytes rather than against labels: the interesting failures are a
 * payload that claims to be a JPEG and is not, and a real image in a format
 * Meta would refuse at the one moment it matters.
 */

/** A minimal but structurally real JPEG header: SOI, then an APP0/JFIF segment. */
function jpegHeader(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00,
  ]);
}

/** A 1x1 PNG, signature and IHDR included, so dimensions are readable. */
function png1x1(): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  return buffer;
}

/** A lossy WebP (`VP8 `) container declaring 64x48. */
function webpLossy(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(32, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
}

describe('sniffImageType', () => {
  it('recognises the three formats Meta will send', () => {
    expect(sniffImageType(jpegHeader())).toBe('image/jpeg');
    expect(sniffImageType(png1x1())).toBe('image/png');
    expect(sniffImageType(webpLossy(64, 48))).toBe('image/webp');
  });

  it('refuses a GIF, which is a real image Meta will not accept as a photo', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16)]);
    expect(sniffImageType(gif)).toBeNull();
  });

  it('refuses a PDF wearing an image extension', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(16)]);
    expect(sniffImageType(pdf)).toBeNull();
  });

  it('refuses HTML, which is the payload that matters if these were served raw', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'ascii');
    expect(sniffImageType(html)).toBeNull();
  });

  it('refuses a PNG whose signature was mangled by a text-mode transfer', () => {
    const mangled = png1x1();
    // The CRLF pair in the signature exists precisely to catch this.
    mangled[4] = 0x0a;
    expect(sniffImageType(mangled)).toBeNull();
  });
});

describe('inspectImageUpload', () => {
  it('accepts a bare base64 payload and reports its real type', () => {
    const result = inspectImageUpload(png1x1().toString('base64'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mimeType).toBe('image/png');
    expect(result.image.dimensions).toEqual({ width: 1, height: 1 });
  });

  it('accepts a data URL, because that is what FileReader produces', () => {
    const encoded = `data:image/png;base64,${png1x1().toString('base64')}`;
    const result = inspectImageUpload(encoded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mimeType).toBe('image/png');
  });

  it('ignores a lying data URL prefix and trusts the bytes', () => {
    // Declared PNG, actually a JPEG. The stored mime type decides what is later
    // handed to Meta, so believing the label would mean uploading a file whose
    // declared type and contents disagree.
    const encoded = `data:image/png;base64,${jpegHeader().toString('base64')}`;
    const result = inspectImageUpload(encoded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mimeType).toBe('image/jpeg');
  });

  it('rejects something that is not an image at all', () => {
    const result = inspectImageUpload(Buffer.from('not an image', 'ascii').toString('base64'));
    expect(result).toEqual({ ok: false, reason: 'not_an_image' });
  });

  it('rejects a real image in a format that cannot be sent', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32)]);
    const result = inspectImageUpload(gif.toString('base64'));
    expect(result).toEqual({ ok: false, reason: 'unsupported_format' });
  });

  it('rejects an empty payload', () => {
    expect(inspectImageUpload('')).toEqual({ ok: false, reason: 'empty' });
    expect(inspectImageUpload('data:image/png;base64,')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a payload that is not base64', () => {
    expect(inspectImageUpload('!!!! not base64 !!!!')).toEqual({
      ok: false,
      reason: 'malformed_encoding',
    });
  });

  it('rejects anything over the 5 MB cap before decoding it', () => {
    // Deliberately a string, not a buffer: the length check has to happen on
    // the encoded form, or an oversized upload becomes an oversized allocation
    // first and the cap protects nothing.
    const oversized = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024);
    expect(inspectImageUpload(oversized)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('readWebpDimensions', () => {
  it('reads a lossy WebP canvas', () => {
    expect(readWebpDimensions(webpLossy(64, 48))).toEqual({ width: 64, height: 48 });
  });

  it('masks off the two scaling bits above the 14-bit dimensions', () => {
    const buffer = webpLossy(0, 0);
    // Width 300 with both scaling bits set: the raw 16-bit value is not the
    // width, and reading it as one would report a 49452-pixel image.
    buffer.writeUInt16LE(300 | 0xc000, 26);
    buffer.writeUInt16LE(200 | 0xc000, 28);
    expect(readWebpDimensions(buffer)).toEqual({ width: 300, height: 200 });
  });

  it('returns null for a format it does not cover', () => {
    expect(readWebpDimensions(png1x1())).toBeNull();
  });
});

describe('unusable but recognisable formats', () => {
  it('tells an iPhone owner to convert a HEIC rather than that it is not an image', () => {
    const heic = Buffer.alloc(32);
    heic.write('ftyp', 4, 'ascii');
    heic.write('heic', 8, 'ascii');
    expect(inspectImageUpload(heic.toString('base64'))).toEqual({
      ok: false,
      reason: 'unsupported_format',
    });
  });

  it('treats a BMP and a TIFF as images it will not store', () => {
    const bmp = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(32)]);
    const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(32)]);
    expect(inspectImageUpload(bmp.toString('base64'))).toEqual({
      ok: false,
      reason: 'unsupported_format',
    });
    expect(inspectImageUpload(tiff.toString('base64'))).toEqual({
      ok: false,
      reason: 'unsupported_format',
    });
  });
});
