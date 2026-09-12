import { mintDevToken } from '../modules/dev/dev-token.js';
import { applyDotEnv } from '../config/env.js';

applyDotEnv();

/**
 * Mints a development token for local sign-in while the XMS Clerk
 * application is not provisioned. The API accepts it only when
 * AUTH_DEV_SECRET is set, which the environment contract refuses in
 * production. The claims are shaped by `mintDevToken`, shared with the
 * /v1/dev/sign-in endpoint so the two cannot drift.
 *
 * The sign-in page offers the seeded users directly, so this is now for
 * scripting and for a user the seed does not create.
 *
 *   pnpm dev:token --email admin@example.test [--sub user_123] [--org hackett] [--hours 12] [--aud xms-axel]
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  const secret = process.env.AUTH_DEV_SECRET;
  if (!secret) {
    console.error('AUTH_DEV_SECRET is not set (see .env.example)');
    process.exit(2);
  }
  const email = arg('email');
  if (!email) {
    console.error('--email is required');
    process.exit(2);
  }
  const token = await mintDevToken({
    secret,
    email,
    org: arg('org', 'hackett')!,
    sub: arg('sub'),
    hours: Number(arg('hours', '12')),
    audience: arg('aud'),
    authorizedParty: arg('azp', 'http://localhost:3000')!,
  });
  console.log(token);
}

await main();
