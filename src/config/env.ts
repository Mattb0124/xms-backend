import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Environment contract for the API and the worker. Fails fast at boot on a
 * missing or malformed value instead of failing on the first request.
 * Secrets arrive through the ECS task definition from Secrets Manager; none
 * are defaulted here.
 */
const list = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    APP_VERSION: z.string().default('dev'),
    // Database URLs per role (Data Model section 2).
    DATABASE_URL_APP: z.string().url().optional(),
    DATABASE_URL_WORKER: z.string().url().optional(),
    DATABASE_URL_PORTAL: z.string().url().optional(),
    DATABASE_URL_MIGRATOR: z.string().url().optional(),
    /** Where the web app lives, for links in outbound mail (survey prompts, report packs). */
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Seals webhook signing secrets at rest; without it no subscription can be created (fail closed). */
    WEBHOOK_SECRETS_KEY: z.string().min(16).optional(),
    /** Tests and local stacks may deliver to private addresses; production never does. */
    WEBHOOK_ALLOW_PRIVATE: z.enum(['true', 'false']).default('false'),
    // Identity (Security & Tenancy section 2). The XMS Clerk application;
    // authorised parties are the web hosts; the agents audience names the
    // long-lived template accepted only on Axel routes.
    CLERK_ISSUER: z.string().url().optional(),
    CLERK_JWKS_URL: z.string().url().optional(),
    CLERK_AUTHORIZED_PARTIES: list,
    CLERK_AGENTS_AUDIENCE: z.string().optional(),
    CLERK_INTERNAL_ORG_SLUG: z.string().default('hackett'),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_WEBHOOK_SECRET: z.string().optional(),
    // Harness session tokens (AI Integration section 2).
    HARNESS_SESSION_SECRET: z.string().min(16).optional(),
    // Development-only HS256 tokens minted by `pnpm dev:token`; production refuses this.
    AUTH_DEV_SECRET: z.string().min(16).optional(),
    // First administrator(s) accepted by POST /v1/bootstrap while the admin set is empty.
    BOOTSTRAP_ADMIN_EMAILS: list,
    IP_HASH_SALT: z.string().default('local'),
    // Object store (Security section 6): S3 in AWS, a signed local store in development and tests.
    STORAGE_KIND: z.enum(['s3', 'local']).default('local'),
    S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().default('us-east-1'),
    STORAGE_LOCAL_ROOT: z.string().default('.xms-storage'),
    STORAGE_SIGNING_SECRET: z.string().min(16).default('local-storage-signing-secret-change-me'),
    API_BASE_URL: z.string().url().default('http://localhost:3001'),
    // Mail: SES in AWS, files in development.
    MAIL_TRANSPORT: z.enum(['ses', 'file']).default('file'),
    MAIL_DOMAIN: z.string().default('mail.xms.local'),
    SES_CONFIGURATION_SET: z.string().optional(),
    SNS_WEBHOOK_SECRET: z.string().min(16).optional(),
    // Axel harness (AI Integration sections 2 and 3). Without a base URL every AI call is `unavailable`.
    HARNESS_BASE_URL: z.string().url().optional(),
    HARNESS_ORIGIN: z.string().url().default('http://localhost:3000'),
    HARNESS_TENANT_SLUG: z.string().optional(),
    AI_SERVICE_USER_EMAIL: z.string().email().default('axel-service@xms.local'),
    // Rate limits per caller per minute on the outward-facing routes (Security section 9); 0 disables a policy.
    RATE_LIMIT_PORTAL_PER_MINUTE: z.coerce.number().int().min(0).default(300),
    RATE_LIMIT_WEBHOOK_PER_MINUTE: z.coerce.number().int().min(0).default(120),
    RATE_LIMIT_PUBLIC_PER_MINUTE: z.coerce.number().int().min(0).default(60),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_DEV_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_DEV_SECRET'],
          message: 'must not be set in production',
        });
      }
      if (!env.CLERK_ISSUER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLERK_ISSUER'],
          message: 'required in production',
        });
      }
      if (env.CLERK_AUTHORIZED_PARTIES.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLERK_AUTHORIZED_PARTIES'],
          message: 'required in production',
        });
      }
      if (env.STORAGE_KIND !== 's3' || !env.S3_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_KIND'],
          message: 'production requires the S3 store and S3_BUCKET',
        });
      }
      if (env.WEBHOOK_ALLOW_PRIVATE === 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_ALLOW_PRIVATE'],
          message: 'must not be set in production',
        });
      }
      if (env.MAIL_TRANSPORT !== 'ses') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAIL_TRANSPORT'], message: 'production requires SES' });
      }
      if (env.STORAGE_SIGNING_SECRET.startsWith('local-')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_SIGNING_SECRET'],
          message: 'required in production',
        });
      }
      if (env.IP_HASH_SALT === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['IP_HASH_SALT'],
          message: 'required in production',
        });
      }
    }
    if (env.CLERK_ISSUER && env.CLERK_AUTHORIZED_PARTIES.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CLERK_AUTHORIZED_PARTIES'],
        message: 'required with CLERK_ISSUER',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Local development reads `.env` from the working directory (never in
 * production, where the task definition is the only source). Values
 * already present in the process environment win, so a shell override
 * still works. Deliberately minimal: KEY=VALUE lines, `#` comments, optional
 * surrounding quotes; no interpolation.
 */
export function applyDotEnv(target: NodeJS.ProcessEnv = process.env, file = join(process.cwd(), '.env')): string[] {
  // Never in production (the task definition is the source) and never under the test runner (a developer's
  // .env must not leak into a suite that sets its own environment).
  if (target.NODE_ENV === 'production' || target.NODE_ENV === 'test' || target.VITEST !== undefined) return [];
  if (!existsSync(file)) return [];
  const applied: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (target[key] !== undefined) continue;
    target[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
    applied.push(key);
  }
  return applied;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  if (source === process.env) applyDotEnv(source);
  // An empty value (KEY= in .env or the task definition) means "unset", never an empty URL or secret.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
