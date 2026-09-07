import { z } from 'zod';

/**
 * Environment is validated once at boot and never read from `process.env`
 * again. A missing or malformed variable should crash the process immediately
 * with a readable message, not surface as a confusing runtime failure later.
 */
/**
 * Treats an empty string as absent.
 *
 * docker-compose passes an unset variable through as `FOO=` rather than
 * omitting it, so an optional setting arrives as '' - which is a string, and
 * therefore passes `.optional()` and fails every other rule attached to it. The
 * result is a server that refuses to boot because a variable the operator
 * deliberately left blank is "too short" or "not a valid URL".
 */
function blankIsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

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
  SIGNUP_CODE: blankIsUnset(z.string().min(4).optional()),

  /**
   * Paddle, who take the money.
   *
   * All optional, and deliberately so: without them the server runs, the shop
   * shows, keys already granted still spend, and only buying is unavailable.
   * A deployment that has not set up billing should not fail to boot.
   */
  PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PADDLE_API_KEY: blankIsUnset(z.string().min(10).optional()),
  PADDLE_WEBHOOK_SECRET: blankIsUnset(z.string().min(10).optional()),
  /** Price ids from the Paddle catalogue. */
  PADDLE_PRICE_SUBSCRIPTION: blankIsUnset(z.string().min(3).optional()),
  PADDLE_PRICE_KEYS_5: blankIsUnset(z.string().min(3).optional()),
  PADDLE_PRICE_KEYS_15: blankIsUnset(z.string().min(3).optional()),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  /**
   * Outgoing mail, as one connection string:
   *
   *   smtps://user:pass@smtp.provider.com:465
   *
   * Optional, and deliberately so. Left unset, the server does not fail to
   * start and does not fail requests - it logs the reset link it would have
   * sent, which is what makes password reset developable without a mail server
   * and recoverable on a deployment that has not configured one yet.
   *
   * A password in a URL needs percent-encoding if it contains @ : / or #.
   */
  SMTP_URL: blankIsUnset(z.string().url().optional()),
  /** The From address. Must be one the SMTP provider will let you send as. */
  MAIL_FROM: blankIsUnset(z.string().default('ChitChak <noreply@localhost>')),
  /** How long a reset link stays valid. Long enough to find the email, short enough to matter. */
  PASSWORD_RESET_TTL: z.coerce.number().int().positive().default(60 * 60),
  /**
   * Where the web client is served, which is where a reset link has to point.
   * Not the same as CLIENT_ORIGIN: in production the client lives under /app on
   * the site, while in development it is the Vite server at the root. The
   * default is the development one; production sets it in compose.
   */
  APP_URL: z.string().url().default('http://localhost:5173'),

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
