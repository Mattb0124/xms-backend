import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * The object store behind attachments, raw email and rendered mail
 * (Security & Tenancy 4.5, 6). Keys are account-prefixed
 * (`accounts/<account_id>/...`); presigned uploads are POST with a size
 * range and a content type condition (the proof of concept's presigned PUT
 * could not carry a size limit); downloads are minted only after the
 * RLS-protected row was read by the service.
 *
 * Two implementations: S3 (production, via the AWS SDK with the verified
 * `requestChecksumCalculation: 'WHEN_REQUIRED'` setting) and a local
 * filesystem store for development and tests whose "presigned" URLs point
 * at the API's own signed upload and download routes.
 */
export interface PresignedUpload {
  readonly url: string;
  readonly method: 'POST' | 'PUT';
  readonly fields: Record<string, string>;
  readonly expiresAt: string;
}

export interface ObjectStore {
  readonly kind: 's3' | 'local';
  presignUpload(
    key: string,
    options: { contentType: string; maxBytes: number; expiresSeconds?: number },
  ): Promise<PresignedUpload>;
  presignDownload(
    key: string,
    options: { fileName: string; contentType: string; expiresSeconds?: number },
  ): Promise<string>;
  putObject(key: string, body: Buffer | string, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<{ size: number; contentType?: string } | undefined>;
  moveObject(from: string, to: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9._\-/]{1,512}$/;

export function assertObjectKey(key: string): string {
  if (!KEY.test(key) || key.includes('..') || key.startsWith('/')) throw new Error(`Unsafe object key ${key}`);
  return key;
}

/** Local filesystem store; URLs are signed with an HMAC so the API routes can verify them. */
export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;

  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly baseUrl: string,
  ) {}

  sign(purpose: 'upload' | 'download', key: string, expires: number, extra = ''): string {
    return createHmac('sha256', this.secret).update(`${purpose}\n${key}\n${expires}\n${extra}`).digest('base64url');
  }

  verify(purpose: 'upload' | 'download', key: string, expires: number, signature: string, extra = ''): boolean {
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(purpose, key, expires, extra));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async presignUpload(
    key: string,
    options: { contentType: string; maxBytes: number; expiresSeconds?: number },
  ): Promise<PresignedUpload> {
    assertObjectKey(key);
    const expires = Math.floor(Date.now() / 1000) + (options.expiresSeconds ?? 900);
    const extra = `${options.contentType}\n${options.maxBytes}`;
    const signature = this.sign('upload', key, expires, extra);
    const params = new URLSearchParams({
      key,
      expires: String(expires),
      signature,
      contentType: options.contentType,
      maxBytes: String(options.maxBytes),
    });
    return {
      url: `${this.baseUrl}/v1/storage/upload?${params.toString()}`,
      method: 'PUT',
      fields: {},
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  async presignDownload(
    key: string,
    options: { fileName: string; contentType: string; expiresSeconds?: number },
  ): Promise<string> {
    assertObjectKey(key);
    const expires = Math.floor(Date.now() / 1000) + (options.expiresSeconds ?? 300);
    const signature = this.sign('download', key, expires);
    const params = new URLSearchParams({
      key,
      expires: String(expires),
      signature,
      fileName: options.fileName,
      contentType: options.contentType,
    });
    return `${this.baseUrl}/v1/storage/download?${params.toString()}`;
  }

  private path(key: string): string {
    const full = resolve(this.root, assertObjectKey(key));
    if (!full.startsWith(resolve(this.root) + sep)) throw new Error('Object key escapes the store root');
    return full;
  }

  async putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType }));
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async headObject(key: string): Promise<{ size: number; contentType?: string } | undefined> {
    try {
      const body = await readFile(this.path(key));
      let contentType: string | undefined;
      try {
        contentType = (JSON.parse(await readFile(`${this.path(key)}.meta.json`, 'utf8')) as { contentType?: string })
          .contentType;
      } catch {
        contentType = undefined;
      }
      return { size: body.length, contentType };
    } catch {
      return undefined;
    }
  }

  async moveObject(from: string, to: string): Promise<void> {
    const target = this.path(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.path(from), target);
    await rename(`${this.path(from)}.meta.json`, `${target}.meta.json`).catch(() => undefined);
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
    await rm(`${this.path(key)}.meta.json`, { force: true });
  }
}

export function localStoreRoot(base: string): string {
  return join(base, '.xms-storage');
}
