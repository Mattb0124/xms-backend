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
 * An image that cannot be decoded is not an image. The caller quarantines
 * it with the reason this throws rather than storing bytes nothing here
 * could read.
 */
export const RE_ENCODED_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The longest edge of a stored image, in pixels. */
export const MAX_IMAGE_EDGE = 4000;

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
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ImageNotDecodableError';
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
  try {
    const source = sharp(body, { failOn: 'error' });
    const meta = await source.metadata();
    width = meta.width;
    height = meta.height;
    const pipeline = sharp(body, { failOn: 'error' })
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
    out = toJpeg
      ? await pipeline.jpeg({ quality: 82, progressive: false }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();
  } catch (error) {
    throw new ImageNotDecodableError(
      `the file is declared ${from} but could not be decoded as an image: ${(error as Error).message}`,
    );
  }
  const after = await sharp(out).metadata();
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

/** The stored name says what the stored bytes are, whatever the sender called them. */
function renamed(fileName: string, extension: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${extension}`;
}
