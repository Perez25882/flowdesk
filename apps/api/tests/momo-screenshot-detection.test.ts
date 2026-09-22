import { describe, expect, it, vi } from 'vitest';

// `media.ts` reaches the WhatsApp client, which reaches Prisma. Nothing here
// touches the database, and instantiating the real client in a unit test only
// produces a connection error on a machine with no Postgres.
vi.mock('../src/config/database.js', () => ({ prisma: {} }));

import {
  MOMO_SCREENSHOT_FLAG_THRESHOLD,
  assessMoMoScreenshot,
} from '../src/services/s3/momo-screenshot.js';
import { readImageDimensions } from '../src/services/s3/media.js';

/**
 * The detector decides whether an image reaches the owner's review queue at
 * all. The cases below are the ones that actually arrive on a Ghanaian shop's
 * WhatsApp number: a bare screenshot with no caption from someone who owes
 * money, a captioned one, and the ordinary product photo that must not be
 * mistaken for either.
 *
 * DB-free — the detector takes metadata and returns a score.
 */

const PHONE_SCREENSHOT = { width: 1080, height: 2400 };
const CAMERA_PHOTO = { width: 3000, height: 4000 };

describe('assessMoMoScreenshot', () => {
  it('never flags a non-image', () => {
    const result = assessMoMoScreenshot({
      mimeType: 'application/pdf',
      caption: 'momo payment receipt 450',
    });

    expect(result.confidence).toBe(0);
    expect(result.flagged).toBe(false);
  });

  it('flags a bare screenshot from a customer who owes money', () => {
    // The case the old caption-only detector missed entirely: no caption at
    // all, which is how most MoMo screenshots arrive.
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: null,
      hasOpenUnpaidOrder: true,
    });

    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain('the customer has an order with money outstanding');
  });

  it('does not flag a bare image from a customer with nothing outstanding', () => {
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: null,
      hasOpenUnpaidOrder: false,
    });

    expect(result.flagged).toBe(false);
  });

  it('flags that same bare image once its dimensions show a phone screen capture', () => {
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: null,
      hasOpenUnpaidOrder: false,
      dimensions: PHONE_SCREENSHOT,
    });

    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain('the image is shaped like a phone screenshot');
  });

  it('leaves an ordinary photograph alone, dimensions and all', () => {
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: null,
      hasOpenUnpaidOrder: false,
      dimensions: CAMERA_PHOTO,
    });

    expect(result.flagged).toBe(false);
  });

  it('flags a captioned payment screenshot on the caption alone', () => {
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: 'I have sent the momo, 450 cedis',
      hasOpenUnpaidOrder: false,
    });

    expect(result.flagged).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(MOMO_SCREENSHOT_FLAG_THRESHOLD);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['the caption mentions payment', 'the caption contains an amount']),
    );
  });

  it('does not flag a product photo whose caption is about the product', () => {
    // A false positive costs one dismissal, but an owner who dismisses every
    // photo of a bag of rice stops reading the queue, which costs everything.
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: 'is this the right bag?',
      hasOpenUnpaidOrder: false,
      dimensions: CAMERA_PHOTO,
    });

    expect(result.flagged).toBe(false);
  });

  it('still flags a captioned screenshot from a customer who owes money', () => {
    const result = assessMoMoScreenshot({
      mimeType: 'image/jpeg',
      caption: 'payment sent',
      hasOpenUnpaidOrder: true,
      dimensions: PHONE_SCREENSHOT,
    });

    expect(result.flagged).toBe(true);
    // A ranking, not a probability: it never claims certainty.
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

describe('readImageDimensions', () => {
  it('reads a PNG header', () => {
    const png = Buffer.alloc(32);
    png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(2400, 20);

    expect(readImageDimensions(png)).toEqual({ width: 1080, height: 2400 });
  });

  it('reads a JPEG start-of-frame marker', () => {
    // SOI, then an APP0 segment to skip over, then SOF0 carrying the size.
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x09, 0x60, 0x04, 0x38, 0x03, 0x01, 0x22, 0x00,
    ]);

    expect(readImageDimensions(jpeg)).toEqual({ width: 1080, height: 2400 });
  });

  it('returns null for a format it does not parse, so the caller scores without it', () => {
    expect(readImageDimensions(Buffer.from('RIFF____WEBPVP8 '))).toBeNull();
  });
});
