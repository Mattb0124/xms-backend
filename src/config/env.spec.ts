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
    expect(
      loadEnv({ CORS_ORIGINS: 'https://xms.example, https://portal.example' })
        .CORS_ORIGINS,
    ).toEqual(['https://xms.example', 'https://portal.example']);
    resetEnvForTests();
    expect(() => loadEnv({ PORT: 'eighty' })).toThrow(/PORT/);
  });

  it('rejects a database URL that is not a URL', () => {
    expect(() => loadEnv({ DATABASE_URL_APP: 'not-a-url' })).toThrow(
      /DATABASE_URL_APP/,
    );
  });
});
