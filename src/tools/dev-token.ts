import { SignJWT } from 'jose';
import { DEV_ISSUER } from '../common/auth/token-verifier.js';

/**
 * Mints a development token for local sign-in while the XMS Clerk
 * application is not provisioned. The API accepts it only when
 * AUTH_DEV_SECRET is set, which the environment contract refuses in
 * production. Claims mirror a Clerk session token so the guard runs the
 * same code path.
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
  const sub = arg('sub', `dev_${email.replace(/[^a-z0-9]/gi, '_')}`)!;
  const org = arg('org', 'hackett')!;
  const hours = Number(arg('hours', '12'));
  const audience = arg('aud');
  const party = arg('azp', 'http://localhost:3000')!;
  let builder = new SignJWT({
    email,
    org_slug: org,
    sid: `sess_${Date.now()}`,
    azp: party,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(DEV_ISSUER)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${hours}h`);
  if (audience) builder = builder.setAudience(audience);
  const token = await builder.sign(new TextEncoder().encode(secret));
  console.log(token);
}

await main();
