import { timingSafeEqual } from 'node:crypto';
import type { AuthResponse } from '@chitchak/protocol';
import { loginSchema, refreshSchema, registerSchema } from '@chitchak/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { fakeVerify, hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from '../lib/tokens.js';
import { toSelfUser } from '../services/serialize.js';

function toAuthResponse(
  user: typeof users.$inferSelect,
  accessToken: string,
  refreshToken: string,
): AuthResponse {
  return {
    user: toSelfUser(user),
    accessToken,
    refreshToken,
    expiresIn: config.ACCESS_TOKEN_TTL,
  };
}

async function issueSession(
  user: typeof users.$inferSelect,
  userAgent: string | undefined,
): Promise<AuthResponse> {
  const accessToken = await signAccessToken({ userId: user.id, username: user.username });
  const { token, hash } = generateRefreshToken();

  await db.insert(refreshTokens).values({
    id: generateId(),
    userId: user.id,
    tokenHash: hash,
    expiresAt: refreshTokenExpiry(),
    userAgent: userAgent ?? null,
  });

  return toAuthResponse(user, accessToken, token);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    handler: async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        throw errors.invalid('Check the fields below', fieldErrors(parsed.error.issues));
      }

      // Compared in constant time: a plain !== leaks the code one character at
      // a time to anyone willing to measure the response.
      if (config.SIGNUP_CODE) {
        const supplied = Buffer.from(parsed.data.signupCode ?? '');
        const expected = Buffer.from(config.SIGNUP_CODE);
        const matches =
          supplied.length === expected.length && timingSafeEqual(supplied, expected);
        if (!matches) {
          throw errors.invalid('That signup code is not right', {
            signupCode: 'Ask whoever runs this server for the code',
          });
        }
      }

      // Normalised so that uniqueness is genuinely case-insensitive; the unique
      // indexes are plain equality indexes on these normalised values.
      const email = parsed.data.email.trim().toLowerCase();
      const username = parsed.data.username.trim().toLowerCase();

      const existing = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (existing) throw errors.conflict('An account with that email already exists');

      const usernameTaken = await db.query.users.findFirst({ where: eq(users.username, username) });
      if (usernameTaken) throw errors.conflict('That username is taken');

      const [user] = await db
        .insert(users)
        .values({
          id: generateId(),
          email,
          username,
          displayName: parsed.data.displayName?.trim() || username,
          passwordHash: await hashPassword(parsed.data.password),
        })
        .returning();
      if (!user) throw errors.invalid('Could not create account');

      return reply.code(201).send(await issueSession(user, request.headers['user-agent']));
    },
  });

  app.post('/api/auth/login', {
    // Tight limit: this endpoint is the one worth guessing against.
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('Email and password are required');

      const email = parsed.data.email.trim().toLowerCase();
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });

      if (!user) {
        // Spend the same time hashing as a real attempt would, so response
        // latency does not reveal whether the address is registered.
        await fakeVerify();
        throw errors.unauthorized('Incorrect email or password');
      }

      if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
        throw errors.unauthorized('Incorrect email or password');
      }

      // Opportunistic upgrade: the only moment we hold the plaintext is here.
      if (needsRehash(user.passwordHash)) {
        const passwordHash = await hashPassword(parsed.data.password);
        await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      }

      return issueSession(user, request.headers['user-agent']);
    },
  });

  /**
   * Refresh with rotation and reuse detection.
   *
   * Each refresh token is single-use: presenting one revokes it and issues a
   * successor. Presenting an already-revoked token means someone is replaying a
   * stolen copy, so the entire family is revoked - the legitimate user gets
   * logged out and has to sign in again, which is the correct outcome.
   */
  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const parsed = refreshSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('refreshToken is required');

      const presentedHash = hashRefreshToken(parsed.data.refreshToken);
      const stored = await db.query.refreshTokens.findFirst({
        where: eq(refreshTokens.tokenHash, presentedHash),
      });

      if (!stored) throw errors.unauthorized('Refresh token is not valid');

      if (stored.revokedAt) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, stored.userId), isNull(refreshTokens.revokedAt)));
        request.log.warn({ userId: stored.userId }, 'refresh token reuse detected; revoked all sessions');
        throw errors.unauthorized('Session expired, please sign in again');
      }

      if (stored.expiresAt.getTime() < Date.now()) {
        throw errors.unauthorized('Session expired, please sign in again');
      }

      const user = await db.query.users.findFirst({ where: eq(users.id, stored.userId) });
      if (!user) throw errors.unauthorized('Account no longer exists');

      const next = generateRefreshToken();
      const nextId = generateId();

      await db.transaction(async (tx) => {
        await tx.insert(refreshTokens).values({
          id: nextId,
          userId: user.id,
          tokenHash: next.hash,
          expiresAt: refreshTokenExpiry(),
          userAgent: request.headers['user-agent'] ?? null,
        });
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(), replacedById: nextId })
          .where(eq(refreshTokens.id, stored.id));
      });

      const accessToken = await signAccessToken({ userId: user.id, username: user.username });
      return toAuthResponse(user, accessToken, next.token);
    },
  });

  app.post('/api/auth/logout', {
    handler: async (request, reply) => {
      const parsed = refreshSchema.safeParse(request.body);
      if (parsed.success) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(refreshTokens.tokenHash, hashRefreshToken(parsed.data.refreshToken)));
      }
      // Always 204: whether the token existed is not the caller's business, and
      // a client logging out should never see an error.
      return reply.code(204).send();
    },
  });

  // GET/PATCH /api/users/@me live in users.routes.ts alongside the rest of the
  // profile surface.
}

function fieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'body';
    out[key] ??= issue.message;
  }
  return out;
}
