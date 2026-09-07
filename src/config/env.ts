import { z } from 'zod';

/**
 * Environment contract for the API and the worker. Fails fast at boot on a
 * missing or malformed value instead of failing on the first request.
 * Secrets arrive through the ECS task definition from Secrets Manager; none
 * are defaulted here.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  // Database URLs per role (Data Model section 2); required from P1.3.2 onward.
  DATABASE_URL_APP: z.string().url().optional(),
  DATABASE_URL_WORKER: z.string().url().optional(),
  DATABASE_URL_PORTAL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
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
