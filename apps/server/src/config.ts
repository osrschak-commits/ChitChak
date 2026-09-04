import { z } from 'zod';

/**
 * Environment is validated once at boot and never read from `process.env`
 * again. A missing or malformed variable should crash the process immediately
 * with a readable message, not surface as a confusing runtime failure later.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /**
   * When set, registration requires this code. Leave unset and anyone who can
   * reach the API can create an account - fine on a laptop, not fine on a
   * public domain.
   */
  SIGNUP_CODE: z.string().min(4).optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_HOST: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32, 'LIVEKIT_API_SECRET must be at least 32 characters'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`Invalid environment configuration:\n${problems}\n\nDid you copy .env.example to .env?`);
    process.exit(1);
  }

  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET.startsWith('dev-only')) {
      console.error('Refusing to start: JWT_SECRET is still the development placeholder.');
      process.exit(1);
    }
    if (env.LIVEKIT_API_SECRET.startsWith('devsecret')) {
      console.error('Refusing to start: LIVEKIT_API_SECRET is still the development placeholder.');
      process.exit(1);
    }
  }
  return env;
}

export const config = loadConfig();
export const isProduction = config.NODE_ENV === 'production';
