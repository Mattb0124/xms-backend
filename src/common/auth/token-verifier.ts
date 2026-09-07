import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Token verification (Security & Tenancy 2.1 to 2.3). One verifier per
 * token type, each verifying exactly once, composed by `TokenVerifiers`.
 *
 * - Clerk session JWTs (RS256 against the instance JWKS) with the issuer,
 *   `authorizedParties` (the `azp` claim) and a 60-second clock skew.
 * - Clerk long-lived `agents` template tokens carry a distinct `aud`; they
 *   are accepted only where the route opts in (`@AxelRoute()`).
 * - Harness session tokens (HS256 with the shared session secret, `type`
 *   must be `session`).
 * - Development tokens (HS256 with AUTH_DEV_SECRET, issuer `xms-dev`), only
 *   when the environment allows them; production refuses the setting.
 *
 * API keys are not JWTs and are handled by the guard through the API client
 * repository (prefix, SHA-256 lookup, bcrypt confirm).
 */
export const CLOCK_TOLERANCE_SECONDS = 60;
export const DEV_ISSUER = 'xms-dev';

export type TokenType = 'clerk' | 'clerk_agents' | 'harness' | 'dev';

export interface VerifiedToken {
  readonly type: TokenType;
  readonly subject: string;
  readonly email?: string;
  readonly sessionId?: string;
  readonly orgSlug?: string;
  readonly audience?: string;
  readonly claims: JWTPayload;
}

export class TokenRejectedError extends Error {
  constructor(
    readonly reason:
      | 'garbage'
      | 'expired'
      | 'bad_issuer'
      | 'bad_audience'
      | 'bad_signature'
      | 'bad_party'
      | 'bad_type',
  ) {
    super(`token rejected: ${reason}`);
  }
}

export interface ClerkVerifierOptions {
  readonly issuer: string;
  readonly jwksUrl?: string;
  readonly authorizedParties: readonly string[];
  /** The `aud` of the long-lived agents template; undefined disables it. */
  readonly agentsAudience?: string;
  /** Test seam: a local key resolver instead of the remote JWKS. */
  readonly keys?: JWTVerifyGetKey;
}

export interface TokenVerifiersOptions {
  readonly clerk?: ClerkVerifierOptions;
  readonly harnessSessionSecret?: string;
  readonly devSecret?: string;
}

type Verify = (token: string) => Promise<VerifiedToken>;

export class TokenVerifiers {
  private readonly clerkKeys?: JWTVerifyGetKey;

  constructor(private readonly options: TokenVerifiersOptions) {
    if (options.clerk) {
      const url =
        options.clerk.jwksUrl ??
        `${options.clerk.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
      this.clerkKeys = options.clerk.keys ?? createRemoteJWKSet(new URL(url));
    }
  }

  /** Routes the token to one verifier by its unverified claims, then verifies once. */
  async verify(token: string): Promise<VerifiedToken> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    let claims: JWTPayload;
    try {
      header = decodeProtectedHeader(token);
      claims = decodeJwt(token);
    } catch {
      throw new TokenRejectedError('garbage');
    }
    const verifier = this.select(header.alg, claims);
    return verifier(token);
  }

  private select(alg: string | undefined, claims: JWTPayload): Verify {
    if (claims.iss === DEV_ISSUER) {
      if (!this.options.devSecret) throw new TokenRejectedError('bad_issuer');
      return this.verifyDev;
    }
    if (claims['type'] === 'session') {
      if (!this.options.harnessSessionSecret)
        throw new TokenRejectedError('bad_issuer');
      return this.verifyHarness;
    }
    if (this.options.clerk && alg === 'RS256') {
      return this.verifyClerk;
    }
    throw new TokenRejectedError('bad_issuer');
  }

  private readonly verifyClerk: Verify = async (token) => {
    const clerk = this.options.clerk!;
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.clerkKeys!, {
        issuer: clerk.issuer,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        algorithms: ['RS256'],
      });
      payload = result.payload;
    } catch (error) {
      throw new TokenRejectedError(classify(error));
    }
    const party = payload['azp'];
    if (typeof party !== 'string' || !clerk.authorizedParties.includes(party)) {
      throw new TokenRejectedError('bad_party');
    }
    const audience = audienceOf(payload);
    const type: TokenType =
      audience && clerk.agentsAudience && audience === clerk.agentsAudience
        ? 'clerk_agents'
        : 'clerk';
    if (audience && type === 'clerk') {
      // A Clerk session token normally carries no aud; any other audience is
      // a template we did not define for this API.
      throw new TokenRejectedError('bad_audience');
    }
    return {
      type,
      subject: requireSubject(payload),
      email: stringClaim(payload, 'email'),
      sessionId: stringClaim(payload, 'sid'),
      orgSlug: stringClaim(payload, 'org_slug'),
      audience,
      claims: payload,
    };
  };

  private readonly verifyHarness: Verify = async (token) => {
    const secret = new TextEncoder().encode(this.options.harnessSessionSecret!);
    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(token, secret, {
          algorithms: ['HS256'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        })
      ).payload;
    } catch (error) {
      throw new TokenRejectedError(classify(error));
    }
    if (payload['type'] !== 'session') throw new TokenRejectedError('bad_type');
    return {
      type: 'harness',
      subject: requireSubject(payload),
      email: stringClaim(payload, 'email'),
      sessionId:
        stringClaim(payload, 'session_id') ?? stringClaim(payload, 'sid'),
      claims: payload,
    };
  };

  private readonly verifyDev: Verify = async (token) => {
    const secret = new TextEncoder().encode(this.options.devSecret!);
    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(token, secret, {
          algorithms: ['HS256'],
          issuer: DEV_ISSUER,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        })
      ).payload;
    } catch (error) {
      throw new TokenRejectedError(classify(error));
    }
    return {
      type: 'dev',
      subject: requireSubject(payload),
      email: stringClaim(payload, 'email'),
      sessionId: stringClaim(payload, 'sid'),
      orgSlug: stringClaim(payload, 'org_slug'),
      audience: audienceOf(payload),
      claims: payload,
    };
  };
}

function classify(error: unknown): TokenRejectedError['reason'] {
  const code = (error as { code?: string }).code;
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (error as { claim?: string }).claim;
      if (claim === 'iss') return 'bad_issuer';
      if (claim === 'aud') return 'bad_audience';
      return 'garbage';
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'bad_signature';
    default:
      return 'garbage';
  }
}

function requireSubject(payload: JWTPayload): string {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0)
    throw new TokenRejectedError('garbage');
  return payload.sub;
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function audienceOf(payload: JWTPayload): string | undefined {
  if (typeof payload.aud === 'string') return payload.aud;
  if (Array.isArray(payload.aud) && payload.aud.length === 1)
    return payload.aud[0];
  return undefined;
}
