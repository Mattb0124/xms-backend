import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertObjectKey, type ObjectStore, type PresignedUpload } from './object-store.js';

/** S3 implementation (Security & Tenancy 6): presigned POST with content-length-range and a content type condition. */
export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    // Verified AIX fix for presigned uploads: do not add checksum headers the
    // browser cannot reproduce (app-api file-storage.service.ts).
    this.client = new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED' });
  }

  async presignUpload(
    key: string,
    options: { contentType: string; maxBytes: number; expiresSeconds?: number },
  ): Promise<PresignedUpload> {
    assertObjectKey(key);
    const expires = options.expiresSeconds ?? 900;
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 0, options.maxBytes],
        ['eq', '$Content-Type', options.contentType],
      ],
      Fields: { 'Content-Type': options.contentType },
      Expires: expires,
    });
    return {
      url: post.url,
      method: 'POST',
      fields: post.fields,
      expiresAt: new Date(Date.now() + expires * 1000).toISOString(),
    };
  }

  presignDownload(
    key: string,
    options: { fileName: string; contentType: string; expiresSeconds?: number },
  ): Promise<string> {
    assertObjectKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${options.fileName.replace(/["\r\n]/g, '')}"`,
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresSeconds ?? 300 },
    );
  }

  async putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: assertObjectKey(key), Body: body, ContentType: contentType }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: assertObjectKey(key) }));
    const bytes = await result.Body?.transformToByteArray();
    return Buffer.from(bytes ?? new Uint8Array());
  }

  async headObject(key: string): Promise<{ size: number; contentType?: string } | undefined> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: assertObjectKey(key) }));
      return { size: head.ContentLength ?? 0, contentType: head.ContentType };
    } catch {
      return undefined;
    }
  }

  async moveObject(from: string, to: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${assertObjectKey(from)}`,
        Key: assertObjectKey(to),
      }),
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: from }));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: assertObjectKey(key) }));
  }
}
