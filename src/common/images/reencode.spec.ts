import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ImageNotDecodableError,
  isReEncodedImage,
  MAX_IMAGE_EDGE,
  reEncodeImage,
  RE_ENCODED_IMAGE_TYPES,
} from './reencode.js';

/**
 * The image re-encode (Security & Tenancy section 6). Every buffer here is
 * constructed in the test: a flat colour of a known size, given metadata on
 * purpose, so the assertions are about what the re-encode removed rather
 * than about a sample file nobody can read.
 */
const swatch = (width: number, height: number): sharp.Sharp =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } });

let png: Buffer;
let jpeg: Buffer;
let gif: Buffer;
let huge: Buffer;

beforeAll(async () => {
  png = await swatch(64, 40)
    .withExifMerge({ IFD0: { Copyright: 'A client of ours', Artist: 'Someone' } })
    .png()
    .toBuffer();
  jpeg = await swatch(80, 50)
    .withExifMerge({ IFD0: { Copyright: 'A client of ours', Software: 'Their camera' } })
    .jpeg()
    .toBuffer();
  gif = await swatch(32, 32).gif().toBuffer();
  huge = await swatch(MAX_IMAGE_EDGE + 600, 1200)
    .png()
    .toBuffer();
});

describe('which files are re-encoded', () => {
  it('covers the image types the allowlist admits and nothing else', () => {
    for (const type of RE_ENCODED_IMAGE_TYPES) expect(isReEncodedImage(type)).toBe(true);
    expect(isReEncodedImage('IMAGE/PNG')).toBe(true);
    expect(isReEncodedImage('application/pdf')).toBe(false);
    expect(isReEncodedImage('text/plain')).toBe(false);
  });
});

describe('re-encoding an image', () => {
  it('keeps a JPEG a JPEG and leaves no metadata behind', async () => {
    const before = await sharp(jpeg).metadata();
    expect(before.exif).toBeDefined();

    const encoded = await reEncodeImage(jpeg, 'image/jpeg', 'holiday.JPG');
    expect(encoded.contentType).toBe('image/jpeg');
    expect(encoded.fileName).toBe('holiday.jpg');

    const after = await sharp(encoded.body).metadata();
    expect(after.format).toBe('jpeg');
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect({ width: after.width, height: after.height }).toEqual({ width: 80, height: 50 });
  });

  it('normalises every other image kind to PNG, name and all', async () => {
    const fromPng = await reEncodeImage(png, 'image/png', 'screenshot.png');
    expect(fromPng.contentType).toBe('image/png');
    expect((await sharp(fromPng.body).metadata()).exif).toBeUndefined();

    const fromGif = await reEncodeImage(gif, 'image/gif', 'animation.gif');
    expect(fromGif.contentType).toBe('image/png');
    expect(fromGif.fileName).toBe('animation.png');
    expect((await sharp(fromGif.body).metadata()).format).toBe('png');
  });

  it('caps the longest edge and says it resized, keeping the aspect ratio', async () => {
    const encoded = await reEncodeImage(huge, 'image/png', 'wide.png');
    const after = await sharp(encoded.body).metadata();
    expect(after.width).toBe(MAX_IMAGE_EDGE);
    expect(after.height).toBe(Math.round((1200 * MAX_IMAGE_EDGE) / (MAX_IMAGE_EDGE + 600)));
    expect(encoded.detail).toMatchObject({
      resized: true,
      original_width: MAX_IMAGE_EDGE + 600,
      original_height: 1200,
      width: MAX_IMAGE_EDGE,
      metadata_stripped: true,
    });
  });

  it('never enlarges a small image and records both sizes', async () => {
    const encoded = await reEncodeImage(png, 'image/png', 'small.png');
    expect(encoded.detail.resized).toBe(false);
    expect(encoded.detail.width).toBe(64);
    expect(encoded.detail.original_bytes).toBe(png.length);
    expect(encoded.detail.bytes).toBe(encoded.body.length);
    expect(encoded.detail.original_content_type).toBe('image/png');
    expect(encoded.detail.content_type).toBe('image/png');
  });

  it('refuses bytes that are not an image, in words a reviewer can read', async () => {
    const notAnImage = Buffer.from('<svg onload="alert(1)"><script>steal()</script></svg>', 'utf8');
    await expect(reEncodeImage(notAnImage, 'image/png', 'trap.png')).rejects.toBeInstanceOf(ImageNotDecodableError);
    await expect(reEncodeImage(notAnImage, 'image/png', 'trap.png')).rejects.toThrow(
      /declared image\/png but could not be decoded/,
    );
  });

  it('refuses a truncated image rather than storing half a file', async () => {
    await expect(reEncodeImage(png.subarray(0, 30), 'image/png', 'cut.png')).rejects.toBeInstanceOf(
      ImageNotDecodableError,
    );
  });
});
