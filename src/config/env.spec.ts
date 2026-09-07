import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvForTests } from './env.js';

describe('loadEnv', () => {
  afterEach(() => resetEnvForTests());

  it('applies safe defaults for local development', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('splits CORS origins and rejects a malformed port', () => {
    expect(loadEnv({ CORS_ORIGINS: 'https://xms.example, https://portal.example' }).CORS_ORIGINS).toEqual([
      'https://xms.example',
      'https://portal.example',
    ]);
    resetEnvForTests();
    expect(() => loadEnv({ PORT: 'eighty' })).toThrow(/PORT/);
  });

  it('rejects a database URL that is not a URL', () => {
    expect(() => loadEnv({ DATABASE_URL_APP: 'not-a-url' })).toThrow(/DATABASE_URL_APP/);
  });
});

describe('loadEnv production guard rails', () => {
  afterEach(() => resetEnvForTests());

  const production = {
    NODE_ENV: 'production',
    CLERK_ISSUER: 'https://clerk.example.test',
    CLERK_AUTHORIZED_PARTIES: 'https://xms.example.test',
    IP_HASH_SALT: 'rotated-salt',
  };

  it('accepts a complete production environment', () => {
    expect(loadEnv(production).CLERK_AUTHORIZED_PARTIES).toEqual(['https://xms.example.test']);
  });

  it('refuses development tokens in production', () => {
    expect(() => loadEnv({ ...production, AUTH_DEV_SECRET: 'not-in-production-ever' })).toThrow(/AUTH_DEV_SECRET/);
  });

  it('requires the Clerk issuer and authorised parties in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', IP_HASH_SALT: 'x' })).toThrow(/CLERK_ISSUER/);
    expect(() => loadEnv({ ...production, CLERK_AUTHORIZED_PARTIES: '' })).toThrow(/CLERK_AUTHORIZED_PARTIES/);
  });

  it('splits bootstrap administrator emails', () => {
    expect(loadEnv({ BOOTSTRAP_ADMIN_EMAILS: 'a@x.test, b@x.test' }).BOOTSTRAP_ADMIN_EMAILS).toEqual([
      'a@x.test',
      'b@x.test',
    ]);
  });
});
