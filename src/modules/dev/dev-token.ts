import { SignJWT } from 'jose';
import { DEV_ISSUER } from '../../common/auth/token-verifier.js';

/**
 * The one place a development token is shaped.
 *
 * The CLI (`pnpm dev:token`) and the sign-in endpoint both call this, because
 * the claims have to match what the guard checks exactly: the issuer it
 * recognises as a dev token, an `azp` it will accept as an authorised party,
 * and an `org_slug` that for a portal user must name that user's own account.
 * Two copies of that would drift, and the failure would read as a confusing
 * 401 rather than as a mismatch.
 */
export interface DevTokenInput {
  readonly secret: string;
  readonly email: string;
  /** `hackett` for an internal user; `acct-<key>` for a portal user. */
  readonly org?: string;
  readonly sub?: string;
  readonly hours?: number;
  readonly audience?: string;
  readonly authorizedParty?: string;
}

/** The subject the seed writes as `clerk_user_id`, so a minted token binds to the seeded row. */
export function devSubjectFor(email: string): string {
  return `dev_${email.replace(/[^a-z0-9]/gi, '_')}`;
}

export async function mintDevToken(input: DevTokenInput): Promise<string> {
  const {
    secret,
    email,
    org = 'hackett',
    sub = devSubjectFor(email),
    hours = 12,
    audience,
    authorizedParty = 'http://localhost:3000',
  } = input;
  let builder = new SignJWT({ email, org_slug: org, sid: `sess_${Date.now()}`, azp: authorizedParty })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(DEV_ISSUER)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${hours}h`);
  if (audience) builder = builder.setAudience(audience);
  return builder.sign(new TextEncoder().encode(secret));
}
