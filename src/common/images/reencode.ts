import sharp from 'sharp';

/**
 * Server-side image re-encoding (Email Intake technical 3 step 4, Ticket
 * Management functional 5.11, Security & Tenancy section 6: "inline images
 * from email are re-encoded server-side (strips active content) before
 * storage").
 *
 * An image that arrives as bytes rather than through a presigned upload is
 * decoded and written out again by `sharp` before it is stored and before
 * the scan gate sees it. Re-encoding is what removes the parts of an image
 * file that are not the picture: an SVG script, an EXIF or XMP block, a
 * colour profile, a comment segment, a polyglot tail after the end marker.
 * Nothing of the original container survives, because the output is built
 * from the decoded pixels.
 *
 * Three rules, and they are the whole of it:
 *
 * - **The format is normalised.** A JPEG stays a JPEG; every other image
 *   kind (PNG, GIF, WebP) is written as PNG. Two output codecs is as small
 *   as the surface gets while keeping photographs from bloating.
 * - **Metadata is stripped.** `sharp` carries no metadata forward unless it
 *   is asked to, and it is not asked to. The one thing read first is the
 *   EXIF orientation, applied to the pixels by `rotate()` so a photograph
 *   does not end up sideways once its EXIF block is gone.
 * - **Dimensions are capped.** The specification set fixes no number, so the
 *   limit lives here: the longest edge is 4000 pixels, which is larger than
 *   any screenshot a client sends and small enough that a decompression
 *   bomb cannot be re-encoded into the object store. A smaller image is
 *   never enlarged.
 *
 * `resize` caps what is written, not what is decoded, so the decode has its
 * own budget in front of it. The header is read first and an image claiming
 * more than `MAX_INPUT_PIXELS` pixels, or an edge over `MAX_INPUT_EDGE`, is
 * refused before a single row is decompressed; `limitInputPixels` is then
 * passed explicitly on every `sharp` construction rather than inheriting
 * the library's 268-megapixel default, so a header that lies is stopped by
 * the decoder as well. Without both, a flat-colour PNG of a few hundred
 * kilobytes declaring 100000 by 100000 pixels is a memory-exhaustion vector
 * reachable by anyone who can email an account's intake alias.
 *
 * An image that cannot be decoded is not an image. The caller quarantines
 * it with the reason this throws rather than storing bytes nothing here
 * could read.
 */
export const RE_ENCODED_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * One thread per decode. With the budget below a worst-case decode is about
 * 160 MB of raw pixels, and libvips fanning that across every core
 * multiplies the peak by the core count for no useful throughput on files
 * this small.
 */
sharp.concurrency(1);

/** The longest edge of a stored image, in pixels. */
export const MAX_IMAGE_EDGE = 4000;

/**
 * The decode budget. Forty megapixels is a 8000 by 5000 photograph, far
 * more than any screenshot or phone camera a client sends, and about
 * 160 MB of raw pixels rather than the gigabyte the library's default
 * ceiling allows.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/** No single edge past this, whatever the product of the two. */
export const MAX_INPUT_EDGE = 20_000;

export interface ReEncodedImage {
  readonly body: Buffer;
  readonly contentType: 'image/png' | 'image/jpeg';
  readonly fileName: string;
  /** What the re-encode did, kept on the attachment row. */
  readonly detail: {
    readonly original_content_type: string;
    readonly content_type: string;
    readonly original_bytes: number;
    readonly bytes: number;
    readonly original_width: number | null;
    readonly original_height: number | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly resized: boolean;
    readonly metadata_stripped: true;
  };
}

export class ImageNotDecodableError extends Error {
  constructor(
    readonly reason: string,
    /** What the caller quarantines it as; both reasons are handled the same way. */
    readonly code: 'image_not_decodable' | 'image_too_large' = 'image_not_decodable',
  ) {
    super(reason);
    this.name = code === 'image_too_large' ? 'ImageTooLargeError' : 'ImageNotDecodableError';
  }
}

/** Whether a file that passed the MIME allowlist is one this re-encodes. */
export function isReEncodedImage(contentType: string): boolean {
  return RE_ENCODED_IMAGE_TYPES.includes(contentType.toLowerCase());
}

export async function reEncodeImage(body: Buffer, contentType: string, fileName: string): Promise<ReEncodedImage> {
  const from = contentType.toLowerCase();
  const toJpeg = from === 'image/jpeg';
  let width: number | undefined;
  let height: number | undefined;
  let out: Buffer;
  let after: sharp.Metadata;
  try {
    // The header is read without decompressing anything, so the dimensions
    // are known before any memory is spent on the pixels. The library's own
    // ceiling is lifted for this read alone, so that an image over the
    // budget is refused in our words with its size named, rather than as a
    // generic decode failure; nothing is decompressed either way.
    const meta = await sharp(body, { failOn: 'error', limitInputPixels: false }).metadata();
    width = meta.width;
    height = meta.height;
    assertWithinBudget(width, height);
    const pipeline = sharp(body, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
    out = toJpeg
      ? await pipeline.jpeg({ quality: 82, progressive: false }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();
    // Reading the output back is part of the re-encode, not a step after
    // it: a failure here is a file to quarantine, not a 500.
    after = await sharp(out, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    if (error instanceof ImageNotDecodableError) throw error;
    throw new ImageNotDecodableError(
      `the file is declared ${from} but could not be decoded as an image: ${(error as Error).message}`,
    );
  }
  const outType = toJpeg ? 'image/jpeg' : 'image/png';
  return {
    body: out,
    contentType: outType,
    fileName: renamed(fileName, toJpeg ? 'jpg' : 'png'),
    detail: {
      original_content_type: from,
      content_type: outType,
      original_bytes: body.length,
      bytes: out.length,
      original_width: width ?? null,
      original_height: height ?? null,
      width: after.width ?? null,
      height: after.height ?? null,
      resized: (width ?? 0) > MAX_IMAGE_EDGE || (height ?? 0) > MAX_IMAGE_EDGE,
      metadata_stripped: true,
    },
  };
}

/**
 * The decode budget, refused from the header rather than survived. An image
 * whose header does not say its size is refused too: an unknown dimension is
 * not a small one.
 */
function assertWithinBudget(width: number | undefined, height: number | undefined): void {
  if (width === undefined || height === undefined)
    throw new ImageNotDecodableError('the image header carries no dimensions', 'image_too_large');
  if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE || width * height > MAX_INPUT_PIXELS)
    throw new ImageNotDecodableError(
      `the image is ${width} by ${height} pixels, over the ${MAX_INPUT_PIXELS} pixel decode budget`,
      'image_too_large',
    );
}

/** The stored name says what the stored bytes are, whatever the sender called them. */
function renamed(fileName: string, extension: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${extension}`;
}
