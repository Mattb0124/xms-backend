import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDotEnv } from './env.js';

describe('the local .env loader', () => {
  it('applies KEY=VALUE lines, strips quotes, skips comments and never overrides the process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xms-env-'));
    const file = join(dir, '.env');
    writeFileSync(
      file,
      ['# comment', 'PORT=3005', "LOG_LEVEL='warn'", 'export MAIL_DOMAIN="mail.test"', 'bad line', 'EMPTY='].join('\n'),
    );
    const target: NodeJS.ProcessEnv = { PORT: '4000' };
    expect(applyDotEnv(target, file).sort()).toEqual(['EMPTY', 'LOG_LEVEL', 'MAIL_DOMAIN']);
    expect(target).toEqual({ PORT: '4000', LOG_LEVEL: 'warn', MAIL_DOMAIN: 'mail.test', EMPTY: '' });
  });

  it('does nothing in production or without a file', () => {
    expect(applyDotEnv({ NODE_ENV: 'production' }, join(tmpdir(), 'nope.env'))).toEqual([]);
    expect(applyDotEnv({}, join(tmpdir(), 'nope.env'))).toEqual([]);
  });
});

describe('the environment contract', () => {
  it('treats empty values as unset so optional URLs and secrets may be left blank', async () => {
    const { loadEnv, resetEnvForTests } = await import('./env.js');
    resetEnvForTests();
    const env = loadEnv({
      NODE_ENV: 'test',
      CLERK_ISSUER: '',
      HARNESS_SESSION_SECRET: '',
      HARNESS_BASE_URL: '',
      PORT: '3010',
    });
    expect(env.CLERK_ISSUER).toBeUndefined();
    expect(env.HARNESS_SESSION_SECRET).toBeUndefined();
    expect(env.PORT).toBe(3010);
    resetEnvForTests();
  });
});
