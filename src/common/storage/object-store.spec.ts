import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPresignLife, LocalObjectStore, MAX_PRESIGN_SECONDS } from './object-store.js';

/**
 * The life of a presigned link (review 2026-09-09 finding 6). SigV4 caps
 * `X-Amz-Expires` at seven days and refuses anything longer when the URL is
 * redeemed, so a caller that asks for fourteen days is minting a link that
 * does not work and telling a client it does. The cap is asserted in the
 * signer so no call site can get it wrong.
 */
describe('the presigned link life', () => {
  it('is seven days at most and refuses a longer one by name', () => {
    expect(MAX_PRESIGN_SECONDS).toBe(604_800);
    expect(assertPresignLife(undefined)).toBe(300);
    expect(assertPresignLife(MAX_PRESIGN_SECONDS)).toBe(MAX_PRESIGN_SECONDS);
    expect(() => assertPresignLife(MAX_PRESIGN_SECONDS + 1)).toThrow(/at most 604800 seconds/);
    expect(() => assertPresignLife(14 * 24 * 3600)).toThrow(/at most 604800 seconds/);
    expect(() => assertPresignLife(0)).toThrow(/at most 604800 seconds/);
  });

  it('holds on the store the tests and development run against', async () => {
    const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'xms-presign-')), 'a-test-secret', 'http://xms.test');
    const link = await store.presignDownload('accounts/a/tickets/b/file.pdf', {
      fileName: 'file.pdf',
      contentType: 'application/pdf',
      expiresSeconds: MAX_PRESIGN_SECONDS,
    });
    const expiresAt = Number(new URL(link).searchParams.get('expires')) * 1000;
    expect(Math.round((expiresAt - Date.now()) / 86_400_000)).toBe(7);

    await expect(
      store.presignDownload('accounts/a/tickets/b/file.pdf', {
        fileName: 'file.pdf',
        contentType: 'application/pdf',
        expiresSeconds: 14 * 24 * 3600,
      }),
    ).rejects.toThrow(/at most 604800 seconds/);
  });
});
