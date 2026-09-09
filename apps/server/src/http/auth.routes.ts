import { timingSafeEqual } from 'node:crypto';
import type { AuthResponse } from '@chitchak/protocol';
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from '@chitchak/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { passwordResets, refreshTokens, users } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { sendMail } from '../lib/mail.js';
import { fakeVerify, hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import {
  generateRefreshToken,
  generateResetToken,
  hashRefreshToken,
  hashResetToken,
  refreshTokenExpiry,
  resetTokenExpiry,
  signAccessToken,
} from '../lib/tokens.js';
import { AWARDED_AT_SIGNUP, award } from '../services/cosmetics.js';
import { toSelfUser } from '../services/serialize.js';
import { currentSuspension, explain } from '../services/suspensions.js';

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

      /*
        Everybody who registers before launch is a founder.

        Deliberately not fatal. The account exists and is theirs whatever
        happens here, and refusing to sign somebody up because a decoration
        could not be written would be a strange trade; a failure is logged so
        the backfill can put it right, which it is built to do anyway.
      */
      if (config.PRE_LAUNCH) {
        for (const cosmeticId of AWARDED_AT_SIGNUP) {
          try {
            await award(user.id, cosmeticId);
          } catch (error: unknown) {
            request.log.error(
              { error, userId: user.id, cosmeticId },
              'could not award signup badge',
            );
          }
        }
      }

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

      /*
        Checked after the password, never before.

        Telling somebody their account is suspended is telling them the account
        exists, so it is only said to whoever proved they own it. Answering the
        wrong password with a suspension notice would turn this endpoint into a
        way of testing which addresses are registered.

        Refused here rather than letting them in: a session that every
        subsequent request rejects is an app that looks broken, and the point of
        a suspension is that the person knows what happened.
      */
      const suspension = currentSuspension(user);
      if (suspension) throw errors.suspended(explain(suspension));

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

      /*
        A suspended account does not get a fresh token.

        The token it would be handed is useless - every authenticated route
        checks - but handing it over is worse than useless. A client that is
        refused on the socket refreshes and reconnects, so leaving this open
        makes a suspended person reconnect for ever instead of being told what
        happened. The refusal is what ends the loop.
      */
      const suspension = currentSuspension(user);
      if (suspension) throw errors.suspended(explain(suspension));

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

  /**
   * Ask for a reset link.
   *
   * Always 204, always immediately, whether or not the address has an account.
   * Both halves of that matter: a different status code would confirm which
   * addresses are registered, and so would a different response time, which is
   * why the work happens after the reply rather than before it. Nothing the
   * caller can observe distinguishes the two cases.
   */
  app.post('/api/auth/password/forgot', {
    // Deliberately tighter than login. Each request sends mail to an address
    // the requester chose, so an unbounded one is both an enumeration oracle
    // and a way to have us spam a stranger.
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = forgotPasswordSchema.safeParse(request.body);
      // Even a malformed address gets the same answer.
      if (parsed.success) {
        const email = parsed.data.email.trim().toLowerCase();
        void deliverResetLink(email, request.log);
      }
      return reply.code(204).send();
    },
  });

  /**
   * Use a reset link.
   *
   * Succeeding here ends every existing session for the account, not just the
   * one that asked. Someone resetting a password because they think it was
   * stolen is not helped by the thief staying signed in.
   */
  app.post('/api/auth/password/reset', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        throw errors.invalid('Check the fields below', fieldErrors(parsed.error.issues));
      }

      const reset = await db.query.passwordResets.findFirst({
        where: eq(passwordResets.tokenHash, hashResetToken(parsed.data.token)),
      });

      // A token that was never issued and one that has expired are the same
      // thing to the person holding it: ask for a new link.
      if (!reset || reset.expiresAt.getTime() < Date.now()) {
        throw errors.invalid('That reset link has expired. Request a new one.');
      }
      // Distinguished only because you must already hold a real token to see
      // it, and "already used" is the difference between "click the newer
      // email" and "start again".
      if (reset.usedAt) {
        throw errors.invalid('That reset link has already been used.');
      }

      const passwordHash = await hashPassword(parsed.data.password);
      const now = new Date();

      await db.transaction(async (tx) => {
        // tokensValidFrom invalidates every access token already issued, which
        // are stateless and cannot be revoked one by one.
        await tx
          .update(users)
          .set({ passwordHash, tokensValidFrom: now })
          .where(eq(users.id, reset.userId));

        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(refreshTokens.userId, reset.userId), isNull(refreshTokens.revokedAt)));

        // Every outstanding link for this account, not just the one used: if
        // several were requested, the rest should not still be live.
        await tx
          .update(passwordResets)
          .set({ usedAt: now })
          .where(and(eq(passwordResets.userId, reset.userId), isNull(passwordResets.usedAt)));
      });

      request.log.info({ userId: reset.userId }, 'password reset; all sessions revoked');
      return reply.code(204).send();
    },
  });

  /**
   * What the client needs to know before anyone has signed in.
   *
   * Public and unauthenticated by necessity - it is read on the sign-up screen.
   * It exposes only whether a code is required, never the code itself, so it
   * tells an attacker nothing they could not learn by attempting to register.
   *
   * Without this the sign-up form had to hedge ("only if your server needs
   * one"), which meant people either typed nothing when a code was required or
   * hunted for one that did not exist.
   */
  app.get('/api/config', async () => ({
    signupCodeRequired: Boolean(config.SIGNUP_CODE),
  }));

  // GET/PATCH /api/users/@me live in users.routes.ts alongside the rest of the
  // profile surface.
}

/**
 * Issues a reset link and mails it, or does nothing at all if the address has
 * no account.
 *
 * Runs after the response has gone out, so it can take as long as SMTP takes
 * without that being visible as a slower reply for a registered address. Every
 * failure inside is logged rather than thrown: there is no longer a request to
 * fail, and the caller was never going to be told either way.
 */
async function deliverResetLink(email: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      log.info({ email }, 'password reset requested for an address with no account');
      return;
    }

    // Only the newest link should work. Without this, every link ever requested
    // stays live until it expires, which widens the window on an old email.
    const now = new Date();
    await db
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

    const { token, hash } = generateResetToken();
    await db.insert(passwordResets).values({
      id: generateId(),
      userId: user.id,
      tokenHash: hash,
      expiresAt: resetTokenExpiry(),
    });

    // The token travels in the URL fragment rather than the query string: a
    // fragment is never sent to the server, so it stays out of access logs and
    // out of the Referer header if the page ever links anywhere.
    const link = `${config.APP_URL.replace(/\/+$/, '')}/#reset=${token}`;
    const hours = Math.round(config.PASSWORD_RESET_TTL / 3600);
    const validFor = hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : 'a short time';

    await sendMail(
      {
        to: user.email,
        subject: 'Reset your ChitChak password',
        text: [
          `Hello ${user.displayName},`,
          '',
          'Someone asked to reset the password for your ChitChak account.',
          `Open this link to choose a new one. It works once, and expires in ${validFor}:`,
          '',
          link,
          '',
          'If that was not you, you can ignore this email - nothing has changed,',
          'and your current password still works.',
        ].join('\n'),
      },
      log,
    );
  } catch (error) {
    log.error({ err: error, email }, 'failed to issue a password reset');
  }
}

function fieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'body';
    out[key] ??= issue.message;
  }
  return out;
}
